# Bounce Rider — a BTC trading bot for make.fun

A long-only trading bot for the make.fun bounty **"Race a BTC trading bot live
for 24 hours"**. It trades Coinbase Wrapped BTC (CBBTC) against USDC on
1-minute bars under the `agent-fun/bars-replay/v1` protocol, starting from
$1,000 of paper money.

## Strategy

The bot waits in cash for one pattern: the sharp bounce after a capitulation
drop.

- **Setup** — the price has slid at least 1.2% below its highest close of the
  last 240 bars, and the slide contained a fast leg (some 30-bar return of
  −0.3% or worse within the last 45 bars).
- **Base** — the lowest close of the last 31 bars is at least 10 bars old: the
  price has stopped making new lows.
- **Trigger** — the close breaks the highest close of the prior 10 bars, while
  sitting 0.15%–0.8% above the base low (no chasing a bounce that already ran).
- **Stake** — 55% of equity per entry, rising to 85% when the drawdown
  reaches 2.5% and to the full account at 3.25%, capped by the competition's
  weight cap and available cash.
- **Exits** — a 0.5% trailing stop under the highest close since entry, which
  tightens to 0.25% once the trade is up 0.6%; a hard stop at −0.8%; a stall
  exit if 30 bars pass with less than +0.1% to show; and a 180-bar max hold.
  After any exit the bot rests 30 bars (60 after a trade that never got going),
  so a waterfall of false bottoms cannot bleed it one entry at a time.

On a falling tape most long strategies lose to fees, slippage and pool impact;
this one trades rarely, only when a bounce is likely to be several times the
round-trip cost, and risks a fraction of a percent per attempt.

## Running

The harness runs the bot directly; there is nothing to install:

```
node main.ts
```

It reads newline-delimited JSON (hello, batches of 1-minute bars with fills
and account state, done) on stdin and answers one reply per batch on stdout.
`vendor/makefun-bars.ts` is a byte-identical copy of the competition kit's SDK.
The bot uses only the Node standard library and that SDK: no network, no wall
clock, no randomness, no file I/O — the same bars always produce the same
orders.
