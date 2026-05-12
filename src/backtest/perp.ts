// Perpetual-futures portfolio. Isolated margin, single-position per dataset,
// one-way mode. Capped at 10x leverage in v0.1. 8h funding accrual is read off
// the candle's `fundingRate` field — funding is part of the dataset, not a
// live feed.
//
// Math reference: see FORMULAS.md 4 ("Perpetual futures portfolio").
//   Funding:      https://www.binance.com/en/support/faq/introduction-to-binance-futures-funding-rates-360033525031
//   Liquidation:  https://www.binance.com/en/support/faq/how-to-calculate-liquidation-price-of-usd%E2%93%A2-m-futures-contracts-b3c689c1f50a44cabb3a84e663b81d93
//   MMR & cum:    https://www.binance.com/en/support/faq/detail/360033162192
//   Fees:         https://www.binance.com/en/fee/futureFee

import type { Action, BacktestOptions, Direction, Trade, TradeReason } from '../types.js';
import { resolveFees } from './fees.js';
import { checkIntraBar, type SLTPLevels } from './sltp.js';

export interface PerpState {
  cash: number;
  /** Signed base units. Long positive, short negative, flat 0. */
  position: number;
  /** Average entry price of the current open position; 0 when flat. */
  entryPrice: number;
  /** Maximum leverage permitted by the run options. */
  leverage: number;
  /** Maker fee as a decimal (reserved for v0.2). */
  makerRate: number;
  /** Taker fee as a decimal (charged on every v0.1 fill). */
  takerRate: number;
  slippageBps: number;
  /** Maintenance margin rate, as a decimal (e.g. 0.05 for 5%). */
  mmr: number;
  /**
   * Maintenance amount "cum" (Binance terminology) in quote currency. v0.1
   * default 0; v0.2 will load this from a per-symbol tier table.
   */
  maintenanceAmount: number;
  /** Active stop-loss price; 0 means none. */
  stopLoss: number;
  /** Active take-profit price; 0 means none. */
  takeProfit: number;
}

const MAX_LEVERAGE = 10;

export function newPerpState(opts: BacktestOptions): PerpState {
  const requested = opts.leverage ?? 1;
  const lev = Math.min(Math.max(1, requested), MAX_LEVERAGE);
  const fees = resolveFees(opts);
  return {
    cash: opts.initialBalance,
    position: 0,
    entryPrice: 0,
    leverage: lev,
    makerRate: fees.makerRate,
    takerRate: fees.takerRate,
    slippageBps: opts.slippageBps ?? 5,
    mmr: (opts.liquidationMarginBps ?? 500) / 10_000,
    maintenanceAmount: opts.maintenanceAmount ?? 0,
    stopLoss: 0,
    takeProfit: 0,
  };
}

export function perpEquity(state: PerpState, mark: number): number {
  return state.cash + unrealizedPnl(state, mark);
}

export function unrealizedPnl(state: PerpState, mark: number): number {
  if (state.position === 0) return 0;
  return state.position * (mark - state.entryPrice);
}

/** Active SL/TP levels (engine reads these). */
export function perpSLTPLevels(state: PerpState): SLTPLevels {
  return { stopLoss: state.stopLoss, takeProfit: state.takeProfit };
}

/**
 * Funding payment per FORMULAS.md 4.3:
 *   funding = positionNotional × fundingRate           (signed)
 *   cash   -= funding
 *
 * Long pays short when rate > 0; short pays long when rate < 0.
 */
export function accrueFunding(state: PerpState, mark: number, rate: number): void {
  if (state.position === 0 || rate === 0) return;
  const notional = state.position * mark; // signed
  state.cash -= notional * rate;
}

/**
 * Maintenance margin requirement at the given mark (Binance USDⓈ-M, isolated).
 *   MM = |position| × mark × MMR − cum
 */
export function maintenanceMargin(state: PerpState, mark: number): number {
  return Math.abs(state.position) * mark * state.mmr - state.maintenanceAmount;
}

/**
 * Closed-form liquidation price for the current position.
 *   LONG  : LP = (pos·entry − WB − cum) / (pos·(1 − MMR))
 *   SHORT : LP = (pos·entry − WB − cum) / (pos·(1 + MMR))
 *
 * Returns 0 when flat (no liquidation price is defined).
 */
export function liquidationPrice(state: PerpState): number {
  if (state.position === 0) return 0;
  const wb = state.cash;
  const num = state.position * state.entryPrice - wb - state.maintenanceAmount;
  const denom = state.position > 0
    ? state.position * (1 - state.mmr)
    : state.position * (1 + state.mmr);
  if (denom === 0) return 0;
  const lp = num / denom;
  return lp < 0 ? 0 : lp;
}

/**
 * Check the maintenance-margin requirement and force-close if breached. The
 * test uses bar-low for longs and bar-high for shorts as the worst-case mark
 * inside the bar — this matches what an exchange would observe intra-bar.
 *
 * If only `mark` is supplied (e.g. legacy callers passing the close), the same
 * value is used as the worst case.
 */
export function maybeLiquidate(
  state: PerpState,
  index: number,
  timestamp: number,
  mark: number,
  worstMark?: number,
): Trade | null {
  if (state.position === 0) return null;
  const checkMark = worstMark ?? mark;
  const equity = perpEquity(state, checkMark);
  const mm = maintenanceMargin(state, checkMark);
  if (equity > mm) return null;
  // Liquidation fills at the trigger mark, not the bar close.
  return closePosition(state, index, timestamp, checkMark, 'liquidation');
}

/**
 * SL/TP force-close. The fill price is the resolved trigger price from
 * `sltp.checkIntraBar` — slippage is applied here against the trader.
 */
export function perpForceCloseAt(
  state: PerpState,
  triggerPrice: number,
  reason: 'stop_loss' | 'take_profit',
  index: number,
  timestamp: number,
): Trade | null {
  if (state.position === 0) return null;
  const slip = state.slippageBps / 10_000;
  // Long closes via sell → price moves down; short closes via buy → price moves up.
  const fillPrice = triggerPrice * (state.position > 0 ? 1 - slip : 1 + slip);
  return closePosition(state, index, timestamp, fillPrice, reason);
}

/** Apply an action to the perp portfolio at `close[index]`. */
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
    state.stopLoss = 0;
    state.takeProfit = 0;
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
  } else {
    const t = openOrAdjust(state, targetPosition, index, timestamp, close, state.position === 0 ? 'open' : 'open');
    if (t) trades.push(t);
  }

  // Refresh active SL/TP from the action. 0 / undefined clears.
  state.stopLoss = action.stopLoss && action.stopLoss > 0 ? action.stopLoss : 0;
  state.takeProfit = action.takeProfit && action.takeProfit > 0 ? action.takeProfit : 0;
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
  const fee = tradeSize * fillPrice * state.takerRate;
  state.cash -= fee;

  // Realized PnL on the reducing leg, if any.
  let realized = 0;
  if (sign(state.position) !== sign(delta) && state.position !== 0) {
    // Reducing toward zero: this leg realizes PnL on `tradeSize` at the entry/fill spread.
    realized = state.position > 0
      ? tradeSize * (fillPrice - state.entryPrice)        // closing a long
      : tradeSize * (state.entryPrice - fillPrice);       // closing a short
    state.cash += realized;
  }

  // Update running entry price.
  if (sign(state.position) === sign(delta) || state.position === 0) {
    const prevAbs = Math.abs(state.position);
    const newAbs = prevAbs + tradeSize;
    state.entryPrice = newAbs === 0
      ? 0
      : (state.entryPrice * prevAbs + fillPrice * tradeSize) / newAbs;
  }
  // Reducing toward zero leaves entryPrice unchanged.

  state.position = targetPosition;
  if (state.position === 0) state.entryPrice = 0;

  return {
    index,
    timestamp,
    side,
    price: fillPrice,
    size: tradeSize,
    fee,
    reason,
    realizedPnl: realized === 0 ? 0 : realized - fee,
  };
}

function closePosition(
  state: PerpState,
  index: number,
  timestamp: number,
  fillMark: number,
  reason: TradeReason,
): Trade | null {
  if (state.position === 0) return null;
  const tradeSize = Math.abs(state.position);
  const side = state.position > 0 ? 'sell' : 'buy';
  // For 'liquidation' / 'stop_loss' / 'take_profit', the caller has already
  // applied slippage to `fillMark`. For 'close' / 'flip' it's a market close
  // at the bar close, so apply slippage here.
  const slip = state.slippageBps / 10_000;
  const fillPrice = reason === 'close' || reason === 'flip'
    ? fillMark * (1 + (side === 'buy' ? slip : -slip))
    : fillMark;
  const realizedGross = state.position * (fillPrice - state.entryPrice);
  const fee = tradeSize * fillPrice * state.takerRate;
  state.cash += realizedGross - fee;
  state.position = 0;
  state.entryPrice = 0;
  return {
    index,
    timestamp,
    side,
    price: fillPrice,
    size: tradeSize,
    fee,
    reason,
    realizedPnl: realizedGross - fee,
  };
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

// Re-export so the engine can resolve SL/TP via the perp module.
export { checkIntraBar };
