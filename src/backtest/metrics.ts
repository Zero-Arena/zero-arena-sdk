// Aggregate metrics. Inputs are deterministic (equity curve, trades) so outputs
// are too. All values that go on-chain are rounded to integers (basis points or
// scaled multiples).

import type { Metrics, Trade } from '../types.js';

export interface MetricsInput {
  initialBalance: number;
  /** Per-candle equity, length === candles.length. */
  equityCurve: number[];
  trades: Trade[];
  /** Bars per year for Sharpe annualization. 1h candles → 8760. */
  barsPerYear: number;
}

export function computeMetrics(input: MetricsInput): Metrics {
  const { initialBalance, equityCurve, trades, barsPerYear } = input;
  const n = equityCurve.length;
  const finalEquity = n > 0 ? (equityCurve[n - 1] as number) : initialBalance;

  const totalReturn = (finalEquity - initialBalance) / initialBalance;
  const totalReturnBps = Math.round(totalReturn * 10_000);

  const sharpeX1000 = annualizedSharpeX1000(equityCurve, barsPerYear);
  const maxDrawdownBps = Math.round(maxDrawdown(equityCurve) * 10_000);
  const winRateBps = Math.round(winRate(trades) * 10_000);

  return {
    totalReturnBps,
    sharpeX1000,
    maxDrawdownBps,
    winRateBps,
    numTrades: trades.length,
    finalEquity,
  };
}

/**
 * Annualized Sharpe (rf=0). Returns Sharpe × 1000, rounded — matches the
 * `sharpeX1000` field on `AgentCertificate.Certificate`.
 */
function annualizedSharpeX1000(equity: number[], barsPerYear: number): number {
  const n = equity.length;
  if (n < 2) return 0;

  // Per-bar log returns. Skip if equity ever goes non-positive (would yield NaN).
  const returns: number[] = new Array(n - 1);
  for (let i = 1; i < n; i++) {
    const prev = equity[i - 1] as number;
    const curr = equity[i] as number;
    if (prev <= 0 || curr <= 0) return 0;
    returns[i - 1] = Math.log(curr / prev);
  }

  let sum = 0;
  for (let i = 0; i < returns.length; i++) sum += returns[i] as number;
  const mean = sum / returns.length;

  let sqSum = 0;
  for (let i = 0; i < returns.length; i++) {
    const d = (returns[i] as number) - mean;
    sqSum += d * d;
  }
  const variance = sqSum / returns.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;

  const sharpe = (mean / std) * Math.sqrt(barsPerYear);
  // Clamp to int64 range and to keep contract uint128 safe (well within bounds).
  return Math.round(sharpe * 1000);
}

function maxDrawdown(equity: number[]): number {
  if (equity.length === 0) return 0;
  let peak = equity[0] as number;
  let maxDd = 0;
  for (let i = 1; i < equity.length; i++) {
    const v = equity[i] as number;
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

/**
 * Fraction of *closed/liquidated* trades that exited at a price favorable to the
 * direction implied by the prior position. Open / flip-open legs are excluded.
 *
 * For a fully realistic per-position win/loss we'd pair trades; this is the
 * conservative "exit-side win rate" — same number on every reproducer because
 * the trade list is deterministic.
 */
function winRate(trades: Trade[]): number {
  if (trades.length === 0) return 0;
  let exits = 0;
  let wins = 0;
  let lastEntry: { price: number; side: 'buy' | 'sell' } | null = null;

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i] as Trade;
    if (t.reason === 'open') {
      lastEntry = { price: t.price, side: t.side };
      continue;
    }
    if (t.reason === 'close' || t.reason === 'liquidation') {
      exits++;
      if (lastEntry !== null) {
        const wonLong = lastEntry.side === 'buy' && t.price > lastEntry.price;
        const wonShort = lastEntry.side === 'sell' && t.price < lastEntry.price;
        if (wonLong || wonShort) wins++;
      }
      lastEntry = null;
      continue;
    }
    if (t.reason === 'flip') {
      // Flip = close-leg followed by open-leg in the trade list. The first flip
      // trade is the close-leg, the second is the new open.
      if (lastEntry !== null) {
        exits++;
        const wonLong = lastEntry.side === 'buy' && t.price > lastEntry.price;
        const wonShort = lastEntry.side === 'sell' && t.price < lastEntry.price;
        if (wonLong || wonShort) wins++;
        lastEntry = null;
      } else {
        lastEntry = { price: t.price, side: t.side };
      }
    }
  }

  return exits === 0 ? 0 : wins / exits;
}
