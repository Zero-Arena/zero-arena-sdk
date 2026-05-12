// Aggregate metrics. Inputs are deterministic (equity curve, trades) so outputs
// are too. All values that go on-chain are rounded to integers (basis points or
// scaled multiples).
//
// Math reference: see FORMULAS.md §6.
//   Sharpe:       https://en.wikipedia.org/wiki/Sharpe_ratio
//   Sortino:      https://en.wikipedia.org/wiki/Sortino_ratio
//   Drawdown:     https://en.wikipedia.org/wiki/Drawdown_(economics)
//   Profit Factor: standard quant metric (Σ wins / Σ |losses|)

import type { Metrics, Trade, TradeReason } from '../types.js';

export interface MetricsInput {
  initialBalance: number;
  /** Per-candle equity, length === candles.length. */
  equityCurve: number[];
  trades: Trade[];
  /** Bars per year for Sharpe annualization. 1h candles → 8760. */
  barsPerYear: number;
}

/** Reasons that mark the *closing leg* of a position. */
const CLOSE_REASONS: ReadonlySet<TradeReason> = new Set([
  'close',
  'flip',
  'liquidation',
  'stop_loss',
  'take_profit',
]);

/** Profit factor cap (×1000). 100× = 100_000 — anything higher is reported as the cap. */
const PF_CAP_X1000 = 100_000;

export function computeMetrics(input: MetricsInput): Metrics {
  const { initialBalance, equityCurve, trades, barsPerYear } = input;
  const n = equityCurve.length;
  const finalEquity = n > 0 ? (equityCurve[n - 1] as number) : initialBalance;

  const totalReturn = (finalEquity - initialBalance) / initialBalance;
  const totalReturnBps = Math.round(totalReturn * 10_000);

  const { sharpeX1000, sortinoX1000 } = annualizedRiskRatios(equityCurve, barsPerYear);
  const maxDrawdownBps = Math.round(maxDrawdown(equityCurve) * 10_000);
  const { winRateBps, profitFactorX1000 } = closeStats(trades);

  return {
    totalReturnBps,
    sharpeX1000,
    sortinoX1000,
    maxDrawdownBps,
    profitFactorX1000,
    winRateBps,
    numTrades: trades.length,
    finalEquity,
  };
}

/**
 * Annualized Sharpe and Sortino in a single pass over the equity curve.
 *
 *   r_t      = ln(equity_t / equity_{t-1})
 *   sharpe   = (mean(r) / std(r))               × sqrt(barsPerYear)
 *   sortino  = (mean(r) / downsideStd(r))       × sqrt(barsPerYear)
 *
 * Both use rf = 0 / target = 0 in v0.1. See FORMULAS.md §6.2 / §6.3.
 */
function annualizedRiskRatios(
  equity: number[],
  barsPerYear: number,
): { sharpeX1000: number; sortinoX1000: number } {
  const n = equity.length;
  if (n < 2) return { sharpeX1000: 0, sortinoX1000: 0 };

  const returns: number[] = new Array(n - 1);
  for (let i = 1; i < n; i++) {
    const prev = equity[i - 1] as number;
    const curr = equity[i] as number;
    if (prev <= 0 || curr <= 0) return { sharpeX1000: 0, sortinoX1000: 0 };
    returns[i - 1] = Math.log(curr / prev);
  }

  let sum = 0;
  for (let i = 0; i < returns.length; i++) sum += returns[i] as number;
  const mean = sum / returns.length;

  let sqSum = 0;
  let downSqSum = 0;
  for (let i = 0; i < returns.length; i++) {
    const r = returns[i] as number;
    const d = r - mean;
    sqSum += d * d;
    if (r < 0) downSqSum += r * r; // target = 0
  }
  const std = Math.sqrt(sqSum / returns.length);
  const downStd = Math.sqrt(downSqSum / returns.length);
  const ann = Math.sqrt(barsPerYear);

  const sharpeX1000 = std === 0 ? 0 : Math.round((mean / std) * ann * 1000);
  const sortinoX1000 = downStd === 0 ? 0 : Math.round((mean / downStd) * ann * 1000);
  return { sharpeX1000, sortinoX1000 };
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
 * Win rate + profit factor over closing legs (`close`, `flip`, `liquidation`,
 * `stop_loss`, `take_profit`). Each closing leg carries `realizedPnl` net of
 * its own fee — the entry-leg fee is already absorbed into cash before the
 * close runs, so summing realizedPnl over closes gives the position-level PnL.
 */
function closeStats(trades: Trade[]): { winRateBps: number; profitFactorX1000: number } {
  let closes = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i] as Trade;
    if (!CLOSE_REASONS.has(t.reason)) continue;
    closes++;
    const pnl = t.realizedPnl;
    if (pnl > 0) {
      wins++;
      grossProfit += pnl;
    } else if (pnl < 0) {
      grossLoss += -pnl;
    }
  }

  const winRateBps = closes === 0 ? 0 : Math.round((wins / closes) * 10_000);

  let profitFactorX1000: number;
  if (grossLoss === 0) {
    profitFactorX1000 = grossProfit > 0 ? PF_CAP_X1000 : 0;
  } else {
    const pf = grossProfit / grossLoss;
    profitFactorX1000 = Math.min(PF_CAP_X1000, Math.round(pf * 1000));
  }

  return { winRateBps, profitFactorX1000 };
}
