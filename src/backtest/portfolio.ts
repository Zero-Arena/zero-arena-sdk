// Spot portfolio. Long-only in v0.1 — short signals on a spot dataset are
// interpreted as "go flat" rather than reversing into a short.
//
// Math reference: see FORMULAS.md 3 ("Spot portfolio") and 1 ("Trading fees").
//   Binance Spot Fee Schedule: https://www.binance.com/en/fee/schedule

import type { Action, BacktestOptions, Trade, TradeReason } from '../types.js';
import { resolveFees } from './fees.js';
import { checkIntraBar, type SLTPLevels } from './sltp.js';

export interface SpotState {
  cash: number;
  position: number; // base units, always >= 0 on spot
  /** Average entry price of the open position; 0 when flat. Used for realized PnL. */
  entryPrice: number;
  /** Maker fee as a decimal (reserved for v0.2 limit orders). */
  makerRate: number;
  /** Taker fee as a decimal (charged on every v0.1 fill). */
  takerRate: number;
  slippageBps: number;
  /** Active stop-loss price; 0 means none. */
  stopLoss: number;
  /** Active take-profit price; 0 means none. */
  takeProfit: number;
}

export function newSpotState(opts: BacktestOptions): SpotState {
  const fees = resolveFees(opts);
  return {
    cash: opts.initialBalance,
    position: 0,
    entryPrice: 0,
    makerRate: fees.makerRate,
    takerRate: fees.takerRate,
    slippageBps: opts.slippageBps ?? 5,
    stopLoss: 0,
    takeProfit: 0,
  };
}

export function spotEquity(state: SpotState, mark: number): number {
  return state.cash + state.position * mark;
}

/** Active SL/TP levels in the form `sltp.checkIntraBar` expects. */
export function spotSLTPLevels(state: SpotState): SLTPLevels {
  return { stopLoss: state.stopLoss, takeProfit: state.takeProfit };
}

/**
 * Trigger SL/TP intra-bar before the agent's `decide` runs on the new candle.
 * Returns a trade if the position was force-closed by SL/TP, or null otherwise.
 *
 * `triggerPrice` is the resolved fill price (level itself, except on gaps).
 */
export function spotForceCloseAt(
  state: SpotState,
  triggerPrice: number,
  reason: 'stop_loss' | 'take_profit',
  index: number,
  timestamp: number,
): Trade | null {
  if (state.position <= 0) return null;
  // Slippage on the protective fill — sells go against by `slippageBps`.
  const slip = state.slippageBps / 10_000;
  const fillPrice = triggerPrice * (1 - slip);
  return sellAll(state, index, timestamp, fillPrice, reason);
}

/** Apply an action to the spot portfolio at `close[index]`. */
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
    state.stopLoss = 0;
    state.takeProfit = 0;
    return trades;
  }

  // Target a position whose notional is `equity * size` (no leverage on spot).
  const equity = spotEquity(state, close);
  const targetNotional = equity * size;
  const targetPosition = targetNotional / close;
  const delta = targetPosition - state.position;

  // Tolerance: ignore micro-rebalances < 1 bp of equity to avoid fee thrashing.
  const minDeltaQuote = equity * 1e-4;
  if (Math.abs(delta * close) >= minDeltaQuote) {
    if (delta > 0) {
      const trade = buy(state, delta, index, timestamp, close, state.position === 0 ? 'open' : 'open');
      if (trade) trades.push(trade);
    } else {
      const trade = sell(state, -delta, index, timestamp, close, 'close');
      if (trade) trades.push(trade);
    }
  }

  // Refresh active SL/TP from the action. `0` / `undefined` clears.
  state.stopLoss = action.stopLoss && action.stopLoss > 0 ? action.stopLoss : 0;
  state.takeProfit = action.takeProfit && action.takeProfit > 0 ? action.takeProfit : 0;
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
  const feeRate = state.takerRate;
  const maxNotional = state.cash / (1 + feeRate);
  if (cost > maxNotional) {
    cost = maxNotional;
    filledSize = cost / fillPrice;
  }
  if (filledSize <= 0) return null;

  const fee = cost * feeRate;
  state.cash -= cost + fee;

  // Update running entry price for the now-larger position.
  const prevAbs = state.position;
  const newAbs = prevAbs + filledSize;
  state.entryPrice = newAbs === 0
    ? 0
    : (state.entryPrice * prevAbs + fillPrice * filledSize) / newAbs;
  state.position = newAbs;

  return { index, timestamp, side: 'buy', price: fillPrice, size: filledSize, fee, reason, realizedPnl: 0 };
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
  const fee = proceeds * state.takerRate;
  const realizedGross = filled * (fillPrice - state.entryPrice);
  state.cash += proceeds - fee;
  state.position -= filled;
  if (state.position === 0) state.entryPrice = 0;
  return {
    index,
    timestamp,
    side: 'sell',
    price: fillPrice,
    size: filled,
    fee,
    reason,
    realizedPnl: realizedGross - fee,
  };
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

// Re-export sltp helper so the engine can call through `portfolio.*`.
export { checkIntraBar };
