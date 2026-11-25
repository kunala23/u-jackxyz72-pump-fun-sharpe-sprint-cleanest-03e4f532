# u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/kunala23/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/kunala23/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Steady-Sharpe paper bot for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty ($2 in USDC). One program, `main.ts` on Node 22, trading paper money on a 6-hour pump.fun replay. Ranked by hourly Sharpe ratio — steady, controlled gains beat one lucky moonshot.

## Strategy

Small, equal stakes (0.05 SOL) spread over many fresh bonding curves, entered only while real buyers dominate the tape and the price is still early in its climb (momentum with a cap, never a parabolic chase). Every position carries a take-profit (+25%), a stop-loss (-15%), a trailing exit, and a hard time exit, so no single coin can drag the hourly Sharpe down. One buy per mint, at most 5 open positions.

- Entry: ≥3 trades, ≥55% of recent SOL volume from buys, price up ≤25% from first sight, not faded 10% off its sampled peak, size cap admits ≥0.02 SOL.
- Exit: +25% take-profit, −15% stop-loss, trailing exit once +15% up and 10% off peak, or 25 batches held.
- Deterministic: decisions come only from the `hello`, `batch` orders and `slot` numbers in the replay — no clock, no randomness, no network. The bot speaks the `agent-fun/replay/v2` protocol directly over stdio (newline-delimited JSON) with no dependencies.

## Run it

```sh
node main.ts
```

The harness feeds it `hello`, then one `batch` per slot window, then `done` on stdin; the bot answers every batch with exactly one `reply` line echoing its `seq`.

## Local grade (dev window)

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree --json
```

Dev result for the submitted commit: net PnL −0.7105 SOL, Sharpe (hourly) −0.595, 495 round trips over 495 distinct mints, max drawdown 7.6%, result `4a2a28a6adc287bf1b257c028e7373ed6ffe7930e9b4a73024976c6339d67910` (process driver; two local runs reproduce byte-for-byte). The dev window is a 24h sample; the final is a fresh 6h window collected after entries close, so dev numbers are a smoke test, not a forecast.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
