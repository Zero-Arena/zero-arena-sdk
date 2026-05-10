// Spot portfolio. Long-only in v0.1 — short signals on a spot dataset are
// interpreted as "go flat" rather than reversing into a short.

import type { Action, BacktestOptions, Trade, TradeReason } from '../types.js';

export interface SpotState {
  cash: number;
  position: number; // base units, always >= 0 on spot
  feeBps: number;
  slippageBps: number;
}

export function newSpotState(opts: BacktestOptions): SpotState {
  return {
    cash: opts.initialBalance,
    position: 0,
    feeBps: opts.feeBps ?? 10,
    slippageBps: opts.slippageBps ?? 5,
  };
}

export function spotEquity(state: SpotState, mark: number): number {
  return state.cash + state.position * mark;
}

/**
 * Apply an action to the spot portfolio at `close[index]`.
 *
 * Returns any trades produced. The state is mutated in place — callers are
 * expected to track the equity curve separately if they need it.
 */
export function applySpotAction(
  state: SpotState,
  action: Action,
  index: number,
  timestamp: number,
  close: number,
): Trade[] {
  const direction = clampDirection(action.direction);
  const size = clampUnit(action.size);
  const trades: Trade[] = [];

  // Spot is long-only: any short signal is treated as "go flat".
  const wantsLong = direction === 1 && size > 0;
  const wantsFlat = !wantsLong;

  if (wantsFlat) {
    if (state.position > 0) {
      const trade = sellAll(state, index, timestamp, close, 'close');
      if (trade) trades.push(trade);
    }
    return trades;
  }

  // Target a position whose notional is `equity * size` (no leverage on spot).
  const equity = spotEquity(state, close);
  const targetNotional = equity * size;
  const targetPosition = targetNotional / close;
  const delta = targetPosition - state.position;

  // Tolerance: ignore micro-rebalances < 1 bp of equity to avoid fee thrashing.
  const minDeltaQuote = equity * 1e-4;
  if (Math.abs(delta * close) < minDeltaQuote) return trades;

  if (delta > 0) {
    const trade = buy(state, delta, index, timestamp, close, state.position === 0 ? 'open' : 'open');
    if (trade) trades.push(trade);
  } else {
    const trade = sell(state, -delta, index, timestamp, close, 'close');
    if (trade) trades.push(trade);
  }
  return trades;
}

function buy(
  state: SpotState,
  size: number,
  index: number,
  timestamp: number,
  close: number,
  reason: TradeReason,
): Trade | null {
  if (size <= 0) return null;
  const fillPrice = close * (1 + state.slippageBps / 10_000);
  let cost = size * fillPrice;
  let filledSize = size;

  // Cap by available cash net of fees.
  const feeRate = state.feeBps / 10_000;
  const maxNotional = state.cash / (1 + feeRate);
  if (cost > maxNotional) {
    cost = maxNotional;
    filledSize = cost / fillPrice;
  }
  if (filledSize <= 0) return null;

  const fee = cost * feeRate;
  state.cash -= cost + fee;
  state.position += filledSize;
  return { index, timestamp, side: 'buy', price: fillPrice, size: filledSize, fee, reason };
}

function sell(
  state: SpotState,
  size: number,
  index: number,
  timestamp: number,
  close: number,
  reason: TradeReason,
): Trade | null {
  if (size <= 0 || state.position <= 0) return null;
  const filled = Math.min(size, state.position);
  const fillPrice = close * (1 - state.slippageBps / 10_000);
  const proceeds = filled * fillPrice;
  const fee = proceeds * (state.feeBps / 10_000);
  state.cash += proceeds - fee;
  state.position -= filled;
  return { index, timestamp, side: 'sell', price: fillPrice, size: filled, fee, reason };
}

function sellAll(
  state: SpotState,
  index: number,
  timestamp: number,
  close: number,
  reason: TradeReason,
): Trade | null {
  return sell(state, state.position, index, timestamp, close, reason);
}

function clampDirection(d: number): -1 | 0 | 1 {
  if (d > 0) return 1;
  if (d < 0) return -1;
  return 0;
}

function clampUnit(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
