// Intra-bar stop-loss / take-profit resolution.
//
// OHLCV data does not record the order in which `high` and `low` were visited
// inside a bar. We follow TradingView's broker-emulator convention, which is
// the de-facto standard for OHLC backtesting:
//
//   * If `open` is closer to `high` than to `low`, assume path
//       open → high → low → close.
//   * Otherwise assume path
//       open → low → high → close.
//   * If `open` is already past the protective level (a gap), fill at `open`
//     — Binance market orders cannot fill at a price that no longer exists.
//   * If both SL and TP would fire on the inferred path, the first one in the
//     path wins. If the inferred path doesn't disambiguate, SL wins
//     (worst-case-for-trader bias).
//
// See FORMULAS.md 5 for the full table and citations.

import type { Candle } from '../types.js';

export interface SLTPLevels {
  /** Protective stop in quote price; 0/undefined → none. */
  stopLoss: number;
  /** Take-profit in quote price; 0/undefined → none. */
  takeProfit: number;
}

export type SLTPTrigger = {
  /** Which level fired. */
  kind: 'stop_loss' | 'take_profit';
  /** Fill price (the level itself, except on gap-through where it's the open). */
  fillPrice: number;
};

/**
 * Determine whether `levels` would have triggered inside `candle` for a position
 * with sign `positionSign` (+1 long, -1 short). Returns the trigger or null.
 *
 * The function is a pure function of `(candle, levels, positionSign)` — no
 * shared state, no randomness, no time. Same inputs → same output, always.
 */
export function checkIntraBar(
  candle: Pick<Candle, 'open' | 'high' | 'low'>,
  levels: SLTPLevels,
  positionSign: -1 | 1,
): SLTPTrigger | null {
  const sl = levels.stopLoss > 0 ? levels.stopLoss : 0;
  const tp = levels.takeProfit > 0 ? levels.takeProfit : 0;
  if (sl === 0 && tp === 0) return null;

  const { open, high, low } = candle;

  // Gap rule: if the bar opens already past the protective level, the order
  // fills at the open. Stop-loss for a long fires on a gap-down; take-profit
  // for a long fires on a gap-up. Symmetric for shorts.
  if (positionSign === 1) {
    if (sl > 0 && open <= sl) return { kind: 'stop_loss', fillPrice: open };
    if (tp > 0 && open >= tp) return { kind: 'take_profit', fillPrice: open };
  } else {
    if (sl > 0 && open >= sl) return { kind: 'stop_loss', fillPrice: open };
    if (tp > 0 && open <= tp) return { kind: 'take_profit', fillPrice: open };
  }

  // Inferred path through the bar.
  const closerToHigh = Math.abs(high - open) <= Math.abs(open - low);
  // Long: SL is a low-side trigger, TP is a high-side trigger.
  // Short: SL is a high-side trigger, TP is a low-side trigger.
  const slHit = positionSign === 1 ? sl > 0 && low <= sl : sl > 0 && high >= sl;
  const tpHit = positionSign === 1 ? tp > 0 && high >= tp : tp > 0 && low <= tp;

  if (!slHit && !tpHit) return null;
  if (slHit && !tpHit) return { kind: 'stop_loss', fillPrice: sl };
  if (tpHit && !slHit) return { kind: 'take_profit', fillPrice: tp };

  // Both could fire — use the inferred path. Whichever side the path visits
  // first, that level fills.
  //   long  : SL = low-side, TP = high-side
  //   short : SL = high-side, TP = low-side
  const slIsHighSide = positionSign === -1;
  const slFirst = closerToHigh ? slIsHighSide : !slIsHighSide;
  return slFirst
    ? { kind: 'stop_loss', fillPrice: sl }
    : { kind: 'take_profit', fillPrice: tp };
}
