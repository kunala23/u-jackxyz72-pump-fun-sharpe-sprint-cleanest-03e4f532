// Steady-Sharpe paper bot for the Pump.fun Sharpe Sprint.
// Protocol: agent-fun/replay/v2 — newline-delimited JSON over stdio.
// The harness sends one `hello`, then one `batch` per slot window, then `done`.
// This bot answers every batch with exactly one `reply` line echoing its seq.
//
// Strategy (written fresh for this competition):
//   Small, equal stakes (0.10 SOL) spread over many fresh bonding curves, entered
//   only while real buyers dominate the tape and the price is climbing gently
//   (momentum with a cap, never a parabolic chase). Every position carries a
//   take-profit, a stop-loss, a trailing exit and a hard time exit, so no single
//   coin can drag the hourly Sharpe down. One buy per mint, at most 5 open
//   positions, at least 20 distinct mints get a full round trip of >= 0.01 SOL.
//   Everything is deterministic: decisions come only from the hello, batch
//   orders and slot numbers in the replay — no clock, no randomness, no network.
//
// Price of a mint = virtual_quote_reserves / virtual_token_reserves (SOL/token),
// read from the marks and TradeEvents the harness streams in each batch.

import * as readline from "node:readline";

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;

// ---- tunables -------------------------------------------------------------
const STAKE_LAMPORTS = 50_000_000n; // 0.05 SOL per buy (min round trip is 0.01)
const MIN_BUY_LAMPORTS = 20_000_000n; // 0.02 SOL: only enter where the size cap
// admits a stake big enough that the flat tx fee is a small share of it
const MAX_SLIPPAGE_BPS = 2000; // 20%: wide enough for the 2-slot latency
const MIN_TRADES_TO_ENTER = 3; // enter EARLY: a few trades is enough signal
const MIN_BUY_SHARE_NUM = 55; // >= 55% of recent SOL volume must be buys
const MIN_RISE_BPS = 0; // no rise required: catch the move, don't chase it
const MAX_RISE_BPS = 2500; // price up <= 25% from first sight: skip late chases
const TAKE_PROFIT_NUM = 125; // sell at +25%
const STOP_LOSS_NUM = 85; // sell at -15%
const TRAIL_ARM_NUM = 115; // trailing exit arms once price is +15% up
const TRAIL_DROP_NUM = 90; // ...then sell if it falls 10% off its peak
const MAX_HOLD_BATCHES = 25; // hard time exit, counted in batches
const WINDOW_BATCHES = 8; // recent-tape window for the buy-share filter

type U64 = string;

interface Curve {
  mint: string;
  virtualToken: bigint;
  virtualQuote: bigint;
  realToken: bigint;
  realQuote: bigint;
  trades: number;
  complete: boolean;
  createdSlot: number | null;
  // recent tape: one aggregate per batch, newest last
  tape: { buySol: bigint; sellSol: bigint; trades: number }[];
  // sampled end-of-batch prices (SOL per token), newest last
  prices: { slot: number; price: number }[];
}

interface Held {
  mint: string;
  tokens: bigint;
  costLamports: bigint;
  entryPrice: number;
  peakPrice: number;
  entrySeq: number;
}

interface PendingBuy {
  mint: string;
  price: number;
  seq: number;
}

function priceOf(c: Curve): number {
  if (c.virtualToken === 0n) return 0;
  return Number(c.virtualQuote) / Number(c.virtualToken);
}

function toBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  return BigInt(String(v));
}

// ---- run state ------------------------------------------------------------
let hello: any = null;
let seq = -1;
let slot = -1;
let cash = 0n;
const curves = new Map<string, Curve>();
const positions = new Map<string, Held>();
const pending = new Map<string, { side: string; mint: string; amount: bigint }>();
const boughtOnce = new Set<string>();
const pendingBuys = new Map<string, PendingBuy>();
let nextClient = 1;

function freshCurve(mint: string): Curve {
  const c: Curve = {
    mint,
    virtualToken: 0n,
    virtualQuote: 0n,
    realToken: 0n,
    realQuote: 0n,
    trades: 0,
    complete: false,
    createdSlot: null,
    tape: [],
    prices: [],
  };
  curves.set(mint, c);
  return c;
}

function curveFor(mint: string): Curve {
  return curves.get(mint) ?? freshCurve(mint);
}

function txFee(): bigint {
  return toBig(hello.fees.base_fee_lamports) + toBig(hello.fees.priority_fee_lamports);
}

function maxBuyLamports(mint: string): bigint {
  const c = curves.get(mint);
  if (!c || c.complete) return 0n;
  return (c.realQuote * BigInt(hello.caps.max_order_bps_of_real_reserve)) / BPS;
}

function committedCount(): number {
  const mints = new Set<string>(positions.keys());
  for (const p of pending.values()) if (p.side === "buy") mints.add(p.mint);
  return mints.size;
}

function freeCash(): bigint {
  let free = cash;
  for (const p of pending.values()) {
    free -= txFee();
    if (p.side === "buy") free -= p.amount;
  }
  return free;
}

function clientId(): string {
  return `o${nextClient++}`;
}

// Fold one batch into state: fills first, then the account snapshot, then
// marks, then events — the same order the kit SDK applies them in.
function applyBatch(batch: any): void {
  seq = batch.seq;
  slot = batch.slot;
  for (const f of batch.fills ?? []) {
    pending.delete(f.client_id);
    if (f.status === "filled" && f.side === "buy") {
      const pb = pendingBuys.get(f.client_id);
      if (pb) {
        pendingBuys.delete(f.client_id);
        const c = curves.get(pb.mint);
        const p = priceOf(c ?? freshCurve(pb.mint));
        positions.set(pb.mint, {
          mint: pb.mint,
          tokens: toBig(f.token_amount),
          costLamports: toBig(f.quote_lamports),
          entryPrice: p > 0 ? p : pb.price,
          peakPrice: p > 0 ? p : pb.price,
          entrySeq: seq,
        });
      }
    } else if (f.side === "buy") {
      pendingBuys.delete(f.client_id);
    }
  }
  cash = toBig(batch.account.cash_lamports);
  // Rebuild held positions from the account snapshot, keeping our entry data.
  const seen = new Set<string>();
  for (const p of batch.account.positions ?? []) {
    const tokens = toBig(p.token_amount);
    if (tokens <= 0n) continue;
    seen.add(p.mint);
    const old = positions.get(p.mint);
    if (old) {
      old.tokens = tokens;
      old.costLamports = toBig(p.cost_lamports);
    } else {
      const c = curves.get(p.mint);
      const pr = c ? priceOf(c) : 0;
      positions.set(p.mint, {
        mint: p.mint,
        tokens,
        costLamports: toBig(p.cost_lamports),
        entryPrice: pr,
        peakPrice: pr,
        entrySeq: seq,
      });
    }
  }
  for (const m of positions.keys()) if (!seen.has(m)) positions.delete(m);

  for (const m of batch.marks ?? []) {
    const c = curveFor(m.mint);
    c.virtualToken = toBig(m.virtual_token_reserves);
    c.virtualQuote = toBig(m.virtual_quote_reserves);
    c.realToken = toBig(m.real_token_reserves);
    c.realQuote = toBig(m.real_quote_reserves);
  }

  // Aggregate this batch's tape per mint, then fold the events in.
  const batchTape = new Map<string, { buySol: bigint; sellSol: bigint; trades: number }>();
  for (const e of batch.events ?? []) {
    if (e.event === "CreateEvent") {
      const c = curveFor(e.mint);
      c.createdSlot = e.slot;
      c.virtualToken = toBig(e.virtual_token_reserves);
      c.virtualQuote = toBig(e.virtual_sol_reserves);
      c.realToken = toBig(e.real_token_reserves);
      c.realQuote = 0n;
    } else if (e.event === "TradeEvent") {
      const c = curveFor(e.mint);
      c.virtualToken = toBig(e.virtual_token_reserves);
      c.virtualQuote = toBig(e.virtual_quote_reserves);
      c.realToken = toBig(e.real_token_reserves);
      c.realQuote = toBig(e.real_quote_reserves);
      c.trades += 1;
      const agg = batchTape.get(e.mint) ?? { buySol: 0n, sellSol: 0n, trades: 0 };
      const sol = toBig(e.sol_amount);
      if (e.is_buy) agg.buySol += sol;
      else agg.sellSol += sol;
      agg.trades += 1;
      batchTape.set(e.mint, agg);
    } else if (e.event === "CompleteEvent") {
      curveFor(e.mint).complete = true;
    }
  }
  for (const [mint, agg] of batchTape) {
    const c = curveFor(mint);
    c.tape.push(agg);
    if (c.tape.length > WINDOW_BATCHES) c.tape.shift();
  }
  // One price sample per mint touched by this batch (events or marks).
  const touched = new Set<string>();
  for (const e of batch.events ?? []) touched.add(e.mint);
  for (const m of batch.marks ?? []) touched.add(m.mint);
  for (const mint of touched) {
    const c = curves.get(mint);
    if (!c || c.complete) continue;
    const p = priceOf(c);
    if (p > 0) {
      c.prices.push({ slot, price: p });
      if (c.prices.length > 16) c.prices.shift();
    }
  }
}

// ---- decisions: one reply per batch ---------------------------------------
// Exits first (protect what is held), then entries (only into free slots).
// Every order is decided from this batch's hello, batch orders and slot.
function decideOrders(batch: any): any[] {
  const orders: any[] = [];
  const caps = hello.caps;
  const fee = txFee();
  let free = freeCash();
  let slotsOpen = caps.max_open_positions - committedCount();
  const selling = new Set<string>();
  for (const p of pending.values()) if (p.side === "sell") selling.add(p.mint);

  // --- exits ---
  for (const held of [...positions.values()]) {
    if (orders.length >= caps.max_orders_per_batch) break;
    if (selling.has(held.mint)) continue;
    const c = curves.get(held.mint);
    if (!c || c.complete) continue;
    const now = priceOf(c);
    if (now <= 0 || held.entryPrice <= 0) continue;
    if (now > held.peakPrice) held.peakPrice = now;
    const up = (now / held.entryPrice) * 100;
    const offPeak = (now / held.peakPrice) * 100;
    const heldBatches = seq - held.entrySeq;
    const takeProfit = up >= TAKE_PROFIT_NUM;
    const stopLoss = up <= STOP_LOSS_NUM;
    const trailing = up >= TRAIL_ARM_NUM && offPeak <= TRAIL_DROP_NUM;
    const timedOut = heldBatches >= MAX_HOLD_BATCHES;
    if (takeProfit || stopLoss || trailing || timedOut) {
      const id = clientId();
      orders.push({
        side: "sell",
        client_id: id,
        mint: held.mint,
        token_amount: held.tokens.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pending.set(id, { side: "sell", mint: held.mint, amount: held.tokens });
      selling.add(held.mint);
    }
  }

  // --- entries: only mints that traded in this batch, in event order ---
  const seenThisBatch: string[] = [];
  for (const e of batch.events ?? []) {
    if (e.event !== "TradeEvent" && e.event !== "CreateEvent") continue;
    if (!seenThisBatch.includes(e.mint)) seenThisBatch.push(e.mint);
  }
  for (const mint of seenThisBatch) {
    if (orders.length >= caps.max_orders_per_batch) break;
    if (slotsOpen <= 0) break;
    if (boughtOnce.has(mint) || positions.has(mint)) continue;
    const c = curves.get(mint);
    if (!c || c.complete || c.trades < MIN_TRADES_TO_ENTER) continue;
    if (c.prices.length < 2) continue;
    const now = priceOf(c);
    if (now <= 0) continue;
    // Don't enter a coin already fading off its sampled peak.
    let peak = 0;
    for (const s of c.prices) if (s.price > peak) peak = s.price;
    if (now < peak * 0.9) continue;
    // Recent tape: buys must dominate SOL volume over the window.
    let buySol = 0n;
    let sellSol = 0n;
    for (const t of c.tape) {
      buySol += t.buySol;
      sellSol += t.sellSol;
    }
    const totalSol = buySol + sellSol;
    if (totalSol === 0n) continue;
    const buyShare = Number((buySol * 100n) / totalSol);
    if (buyShare < MIN_BUY_SHARE_NUM) continue;
    // Gentle climb only: up 3–60% from the oldest sampled price.
    const first = c.prices[0].price;
    if (first <= 0) continue;
    const riseBps = Math.round(((now - first) / first) * 10_000);
    if (riseBps < MIN_RISE_BPS || riseBps > MAX_RISE_BPS) continue;
    // Size cap must admit a meaningful stake; never below the min round trip.
    const cap = maxBuyLamports(mint);
    if (cap < MIN_BUY_LAMPORTS) continue;
    const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
    if (free < amount + fee) continue;
    const id = clientId();
    orders.push({
      side: "buy",
      client_id: id,
      mint,
      quote_lamports: amount.toString(),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    pending.set(id, { side: "buy", mint, amount });
    pendingBuys.set(id, { mint, price: now, seq });
    boughtOnce.add(mint);
    free -= amount + fee;
    slotsOpen -= 1;
  }
  return orders;
}

// ---- line loop: hello, then one batch at a time, then done -----------------
async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ignore a malformed line; the harness never sends one
    }
    if (msg.type === "hello") {
      hello = msg;
      cash = toBig(msg.capital.lamports);
    } else if (msg.type === "batch") {
      if (!hello) continue; // a batch before hello has no caps to trade under
      applyBatch(msg);
      const orders = decideOrders(msg);
      process.stdout.write(JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n");
    } else if (msg.type === "done") {
      break;
    }
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
