// Perpetual-futures portfolio. Isolated margin, single-position per dataset.
// Capped at 10x leverage in v0.1. 8h funding accrual is read off the candle's
// `fundingRate` field — funding is part of the dataset, not a live feed.

import type { Action, BacktestOptions, Direction, Trade, TradeReason } from '../types.js';

export interface PerpState {
  cash: number;
  /** Signed base units. Long positive, short negative, flat 0. */
  position: number;
  /** Average entry price of the current open position; 0 when flat. */
  entryPrice: number;
  /** Maximum leverage permitted by the run options. */
  leverage: number;
  feeBps: number;
  slippageBps: number;
  /** Maintenance margin requirement, in basis points of notional. */
  liqMarginBps: number;
}

const MAX_LEVERAGE = 10;

export function newPerpState(opts: BacktestOptions): PerpState {
  const requested = opts.leverage ?? 1;
  const lev = Math.min(Math.max(1, requested), MAX_LEVERAGE);
  return {
    cash: opts.initialBalance,
    position: 0,
    entryPrice: 0,
    leverage: lev,
    feeBps: opts.feeBps ?? 10,
    slippageBps: opts.slippageBps ?? 5,
    liqMarginBps: opts.liquidationMarginBps ?? 500,
  };
}

export function perpEquity(state: PerpState, mark: number): number {
  return state.cash + unrealizedPnl(state, mark);
}

export function unrealizedPnl(state: PerpState, mark: number): number {
  if (state.position === 0) return 0;
  return state.position * (mark - state.entryPrice);
}

/**
 * Accrue funding for the bar. Funding is paid by longs to shorts when positive,
 * and by shorts to longs when negative — i.e. `funding = positionNotional * rate`,
 * subtracted from cash.
 */
export function accrueFunding(state: PerpState, mark: number, rate: number): void {
  if (state.position === 0 || rate === 0) return;
  const notional = state.position * mark; // signed
  state.cash -= notional * rate;
}

/**
 * Check the maintenance margin requirement and force-close if breached. Returns
 * a liquidation trade if one was triggered, or null.
 */
export function maybeLiquidate(
  state: PerpState,
  index: number,
  timestamp: number,
  mark: number,
): Trade | null {
  if (state.position === 0) return null;
  const notional = Math.abs(state.position) * mark;
  const equity = perpEquity(state, mark);
  const maintenance = notional * (state.liqMarginBps / 10_000);
  if (equity > maintenance) return null;
  return closePosition(state, index, timestamp, mark, 'liquidation');
}

/**
 * Apply an action to the perp portfolio at `close[index]`.
 */
export function applyPerpAction(
  state: PerpState,
  action: Action,
  index: number,
  timestamp: number,
  close: number,
): Trade[] {
  const direction = clampDirection(action.direction);
  const size = clampUnit(action.size);
  const trades: Trade[] = [];

  if (direction === 0 || size === 0) {
    if (state.position !== 0) {
      const t = closePosition(state, index, timestamp, close, 'close');
      if (t) trades.push(t);
    }
    return trades;
  }

  const equity = perpEquity(state, close);
  const targetNotional = equity * size * state.leverage;
  const targetPosition = (targetNotional / close) * direction;
  const currentSign = sign(state.position);
  const wantsSign = sign(targetPosition);

  // If reversing direction, flip = close + reopen (two trades).
  if (currentSign !== 0 && wantsSign !== 0 && currentSign !== wantsSign) {
    const closeT = closePosition(state, index, timestamp, close, 'flip');
    if (closeT) trades.push(closeT);
    const openT = openOrAdjust(state, targetPosition, index, timestamp, close, 'flip');
    if (openT) trades.push(openT);
    return trades;
  }

  const t = openOrAdjust(state, targetPosition, index, timestamp, close, state.position === 0 ? 'open' : 'open');
  if (t) trades.push(t);
  return trades;
}

function openOrAdjust(
  state: PerpState,
  targetPosition: number,
  index: number,
  timestamp: number,
  close: number,
  reason: TradeReason,
): Trade | null {
  const delta = targetPosition - state.position;
  // Tolerance: ignore micro-adjustments < 1 bp of equity.
  const equity = perpEquity(state, close);
  if (Math.abs(delta * close) < equity * 1e-4) return null;

  const tradeSize = Math.abs(delta);
  const side = delta > 0 ? 'buy' : 'sell';
  const slip = state.slippageBps / 10_000;
  const fillPrice = close * (1 + (delta > 0 ? slip : -slip));
  const fee = tradeSize * fillPrice * (state.feeBps / 10_000);
  state.cash -= fee;

  // Update the running average entry price for the new combined position.
  if (sign(state.position) === sign(delta) || state.position === 0) {
    // Adding to (or opening) the position in the same direction.
    const prevAbs = Math.abs(state.position);
    const newAbs = prevAbs + tradeSize;
    state.entryPrice = newAbs === 0
      ? 0
      : (state.entryPrice * prevAbs + fillPrice * tradeSize) / newAbs;
  }
  // Reducing toward zero leaves entryPrice unchanged.

  state.position = targetPosition;
  if (state.position === 0) state.entryPrice = 0;

  return { index, timestamp, side, price: fillPrice, size: tradeSize, fee, reason };
}

function closePosition(
  state: PerpState,
  index: number,
  timestamp: number,
  close: number,
  reason: TradeReason,
): Trade | null {
  if (state.position === 0) return null;
  const tradeSize = Math.abs(state.position);
  const side = state.position > 0 ? 'sell' : 'buy';
  const slip = state.slippageBps / 10_000;
  const fillPrice = close * (1 + (side === 'buy' ? slip : -slip));
  const realized = state.position * (fillPrice - state.entryPrice);
  const fee = tradeSize * fillPrice * (state.feeBps / 10_000);
  state.cash += realized - fee;
  state.position = 0;
  state.entryPrice = 0;
  return { index, timestamp, side, price: fillPrice, size: tradeSize, fee, reason };
}

function sign(n: number): -1 | 0 | 1 {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

function clampDirection(d: number): Direction {
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
