// Bounce rider: a long-only capitulation-reversal bot for 1-minute CBBTC bars.
//
// Idea. On a tape that bleeds downward, almost every long loses: trend following
// whipsaws, dip-buying catches knives, and each round trip pays 4 bps of fee,
// 2 bps of slippage and constant-product impact on top. The one pattern that
// pays for its costs is the sharp bounce that follows a capitulation leg: a
// fast drop exhausts sellers, the price stops making new lows, bases for a few
// minutes, and then snaps back up by several tenths of a percent. This bot
// waits in cash for exactly that shape and rides the snap-back with exits that
// cut dead trades quickly and let a real bounce run.
//
// Entry (all conditions on the symbol's closes, decided on a bar's close and
// filled at the next bar's open):
//   - Drawdown: the close is at least 1.2% under the highest close of the
//     prior 240 bars (a real slide, not a wobble).
//   - Capitulation: some 30-bar return inside the last 46 bars fell at least
//     0.3% (the slide had a fast, exhausting leg, not just a slow drift).
//   - Base: the lowest close of the last 31 bars is at least 10 bars old, so
//     the price has stopped making new lows before we step in.
//   - Trigger: the close breaks the highest close of the prior 10 bars.
//   - No chasing: the close sits between 0.15% and 0.8% above that 31-bar low;
//     further up, the easy part of the bounce is already gone.
// Stake: a fraction of equity that grows with the drawdown's depth — 55%
// normally, 85% once the close is 2.5% under the 240-bar high, 100% at 3.25%
// under — always capped by caps.max_weight_bps room and by cash, and skipped
// under fees.min_notional_quote_units. A deeper capitulation has more room to
// snap back into, and the shallower, more doubtful setups risk less.
//
// Exits (whole position, against the close the entry was decided on):
//   - Trailing stop 0.5% under the highest close since entry; once the peak
//     gain reaches 0.6% the trail tightens to 0.25% to bank the bounce.
//   - Hard stop at -0.8%.
//   - Stall exit: 30 bars in and still under +0.1%, the bounce is dead.
//   - Max hold 180 bars.
// After an exit the bot cools down for 30 bars, 60 after a trade that never
// reached +0.1%: waterfalls produce strings of false bases, and re-entering
// each one is how the costs compound.
//
// Deterministic: float64 arithmetic only (+ - * / and max/min scans), no
// network, no wall clock, no randomness, no file I/O. The same bars produce
// the same orders, byte for byte.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const MAX_SLIPPAGE_BPS = 100;
/** Closes kept per symbol: enough for the 240-bar drawdown window plus lookbacks. */
const KEEP = 400;

const DD_BARS = 240; // drawdown window: highest close of the prior 240 bars
const DD_MIN = 0.012; // close at least 1.2% under that high
const VEL_BARS = 30; // capitulation leg length
const VEL_MIN = 0.003; // a 30-bar return of -0.3% or worse ...
const VEL_WITHIN = 45; // ... within the last 45 bars
const TRIG_BARS = 10; // breakout: close over the prior 10 closes' high
const LOW_BARS = 30; // base window: lowest close of the last 31 bars
const LOW_AGE = 10; // that low must be at least 10 bars old
const OFF_LOW_MIN = 0.0015; // enter 0.15%..0.8% above the base low
const OFF_LOW_MAX = 0.008;
const STAKE_BASE = 0.55; // fraction of equity on a qualifying setup ...
const STAKE_TIERS: readonly (readonly [number, number])[] = [
  [0.025, 0.85], // ... 85% once the drawdown reaches 2.5% ...
  [0.0325, 1.0], // ... and the full account at 3.25%
];

const TRAIL = 0.005; // trailing stop under the peak close
const LOCK_AT = 0.006; // peak gain that arms the tighter trail
const LOCK_TRAIL = 0.0025;
const STOP = 0.008; // hard stop under the entry reference close
const STALL_BARS = 30; // stall exit: this many bars in ...
const STALL_MAX = 0.001; // ... and still under +0.1%
const MAX_HOLD = 180;
const COOLDOWN = 30; // bars of rest after an exit
const COOLDOWN_LOSS = 60; // longer after a trade that never reached +0.1%

interface Series {
  closes: number[];
  /** Bars of cooldown left before a new entry may fire. */
  cool: number;
  /** The open trade's bookkeeping, keyed to the close the entry was decided on. */
  entryRef: number | null;
  peak: number;
  age: number;
  /** A buy was sent last batch but no position has shown up yet. */
  pending: boolean;
}

const series = new Map<string, Series>();

function getSeries(symbol: string): Series {
  let s = series.get(symbol);
  if (s === undefined) {
    s = { closes: [], cool: 0, entryRef: null, peak: 0, age: 0, pending: false };
    series.set(symbol, s);
  }
  return s;
}

/**
 * Whether the closes ending at the newest bar show a capitulation bounce
 * setting up; if so, the drawdown depth (a negative fraction) that sizes it.
 */
function setup(s: Series): number | null {
  const c = s.closes;
  const n = c.length;
  if (n <= DD_BARS) return null;
  const close = c[n - 1];

  let hi = 0;
  for (let k = 2; k <= DD_BARS + 1; k++) hi = Math.max(hi, c[n - k]);
  const dd = close / hi - 1;
  if (dd > -DD_MIN) return null;

  let vel = false;
  for (let back = 0; back <= VEL_WITHIN && back + VEL_BARS < n; back++) {
    if (c[n - 1 - back] / c[n - 1 - back - VEL_BARS] - 1 <= -VEL_MIN) {
      vel = true;
      break;
    }
  }
  if (!vel) return null;

  let trig = 0;
  for (let k = 2; k <= TRIG_BARS + 1; k++) trig = Math.max(trig, c[n - k]);
  if (close <= trig) return null;

  let lo = Infinity;
  let loAge = 0;
  for (let k = LOW_BARS; k >= 0; k--) {
    if (c[n - 1 - k] < lo) {
      lo = c[n - 1 - k];
      loAge = k;
    }
  }
  if (loAge < LOW_AGE) return null;
  const off = close / lo - 1;
  return off >= OFF_LOW_MIN && off <= OFF_LOW_MAX ? dd : null;
}

await runBars({
  onBatch(state: BarsState, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars as Bar[]) {
      const s = getSeries(bar.symbol);
      s.closes.push(Number(bar.c));
      if (s.closes.length > KEEP) s.closes.splice(0, s.closes.length - KEEP);
      fresh.add(bar.symbol);
    }
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const buys: BuyInput[] = [];

    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const s = getSeries(symbol);
      const held = state.positions.get(symbol);
      const close = s.closes[s.closes.length - 1];

      if (held !== undefined) {
        // A position is open: run the exits. A buy sent last batch that never
        // filled leaves entryRef set with no position; that is handled below.
        if (s.entryRef === null) {
          // Position appeared without our bookkeeping (cannot happen in a
          // normal run); adopt this close as the reference and manage it.
          s.entryRef = close;
          s.peak = close;
          s.age = 0;
        }
        s.pending = false;
        s.age += 1;
        if (close > s.peak) s.peak = close;
        const gain = close / s.entryRef - 1;
        const trail = s.peak / s.entryRef - 1 >= LOCK_AT ? LOCK_TRAIL : TRAIL;
        const exit =
          close / s.peak - 1 <= -trail ||
          gain <= -STOP ||
          s.age >= MAX_HOLD ||
          (s.age >= STALL_BARS && gain < STALL_MAX);
        if (exit) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          s.cool = gain < STALL_MAX ? COOLDOWN_LOSS : COOLDOWN;
          s.entryRef = null;
          s.age = 0;
        }
        continue;
      }

      // Flat. A pending buy that produced no position was refused by the
      // market; clear it and rest briefly instead of firing again at once.
      if (s.pending) {
        s.pending = false;
        s.entryRef = null;
        if (s.cool < 15) s.cool = 15;
      }
      if (s.cool > 0) {
        s.cool -= 1;
        continue;
      }
      const dd = setup(s);
      if (dd === null) continue;

      let frac = STAKE_BASE;
      for (const [depth, f] of STAKE_TIERS) if (dd <= -depth) frac = f;
      let notional = (state.equity * BigInt(Math.round(frac * 10_000))) / 10_000n;
      const room = state.weightRoom(symbol);
      if (room < notional) notional = room;
      if (state.cash < notional) notional = state.cash;
      if (notional < BigInt(fees.min_notional_quote_units)) continue;
      buys.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
      s.entryRef = close;
      s.peak = close;
      s.age = 0;
      s.pending = true;
    }

    const orders: (SellInput | BuyInput)[] = [...sells, ...buys];
    return orders.slice(0, caps.max_orders_per_bar);
  },
});
