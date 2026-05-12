// Deterministic backtest loop. The whole verification protocol depends on this
// module producing byte-identical `runHash` values across runs of the same
// (agent, dataset, options) tuple.
//
// Determinism rules — see CLAUDE.md 7:
//  1. No `Math.random` anywhere in the path. (Use a seeded PRNG if ever needed.)
//  2. No `Date.now`. Use `candle.timestamp`.
//  3. No object iteration in the hot path — use arrays + numeric indices.
//  4. Indicators are pre-computed once with fixed iteration order.
//
// Per-bar event order (perp shown; spot drops funding & liquidation):
//  1. Funding accrual         (FORMULAS.md 4.3)
//  2. Liquidation check       (FORMULAS.md 4.4)         worst-mark = low (long) / high (short)
//  3. SL / TP intra-bar check (FORMULAS.md 5)
//  4. agent.decide()          observation snapshot at the bar's close
//  5. apply action            (open/adjust/flip/flat, refreshes SL/TP)
//  6. record equity at close

import type { Agent } from '../agent/Agent.js';
import type { BacktestOptions, BacktestResult, Dataset, Observation, Trade } from '../types.js';
import { ema, macd, rsi } from './indicators.js';
import {
  applySpotAction,
  newSpotState,
  spotEquity,
  spotForceCloseAt,
  spotSLTPLevels,
  type SpotState,
} from './portfolio.js';
import {
  accrueFunding,
  applyPerpAction,
  maybeLiquidate,
  newPerpState,
  perpEquity,
  perpForceCloseAt,
  perpSLTPLevels,
  type PerpState,
} from './perp.js';
import { checkIntraBar } from './sltp.js';
import { computeMetrics } from './metrics.js';
import { composeRunHash, hashAgent, hashOptions, hashTrades } from './hash.js';

/**
 * Bars per year for each supported candle granularity. Crypto trades 24/7,
 * so we use 365 calendar days (not 252 trading days). The Sharpe / Sortino
 * annualization in `metrics.ts` is `× sqrt(barsPerYear)` — wrong value here
 * silently mis-scales every certified result.
 *
 * Until this table existed the engine hard-coded the 1h value (8760), which
 * deflated Sharpe on a 15m dataset by sqrt(4) ≈ 2×.
 */
const BARS_PER_YEAR: Record<string, number> = {
  '1m': 60 * 24 * 365,
  '3m': 20 * 24 * 365,
  '5m': 12 * 24 * 365,
  '15m': 4 * 24 * 365,
  '30m': 2 * 24 * 365,
  '1h': 24 * 365,
  '2h': 12 * 365,
  '4h': 6 * 365,
  '6h': 4 * 365,
  '8h': 3 * 365,
  '12h': 2 * 365,
  '1d': 365,
  '3d': 365 / 3,
  '1w': 52,
};

/**
 * Resolve the annualization factor for a dataset granularity string. Throws
 * on unknown granularity — we'd rather fail loud than silently mis-annualize
 * (per FORMULAS.md 7 "Determinism guarantees").
 */
export function resolveBarsPerYear(granularity: string): number {
  const v = BARS_PER_YEAR[granularity];
  if (v === undefined) {
    throw new Error(
      `resolveBarsPerYear: unsupported granularity "${granularity}". Supported: ${Object.keys(BARS_PER_YEAR).join(', ')}`,
    );
  }
  return v;
}

/** Minimum candle index from which `decide` is called (all indicators fully warm). */
export const WARMUP = 26;

export async function runBacktest(
  agent: Agent,
  dataset: Dataset,
  opts: BacktestOptions,
): Promise<BacktestResult> {
  if (opts.market !== dataset.meta.market) {
    throw new Error(
      `BacktestOptions.market (${opts.market}) does not match dataset market (${dataset.meta.market})`,
    );
  }

  const candles = dataset.candles;
  const n = candles.length;
  if (n === 0) throw new Error('Dataset has no candles');

  // Pre-compute indicators once, in fixed order. This is the only place where
  // the closes array is iterated — agents see their values via the observation.
  const closes: number[] = new Array(n);
  for (let i = 0; i < n; i++) closes[i] = (candles[i] as { close: number }).close;
  const rsi14 = rsi(closes, 14);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdResult = macd(closes, 12, 26, 9);

  const trades: Trade[] = [];
  const equityCurve: number[] = new Array(n);

  if (opts.market === 'spot') {
    const state = newSpotState(opts);
    for (let i = 0; i < n; i++) {
      const candle = candles[i] as {
        timestamp: number; open: number; high: number; low: number; close: number; volume: number;
      };

      // 1. SL/TP intra-bar check before the agent acts.
      if (state.position > 0) {
        const trig = checkIntraBar(candle, spotSLTPLevels(state), 1);
        if (trig) {
          const t = spotForceCloseAt(state, trig.fillPrice, trig.kind, i, candle.timestamp);
          if (t) trades.push(t);
        }
      }

      // 2. Agent decision at close.
      if (i >= WARMUP) {
        const obs: Observation = {
          timestamp: candle.timestamp,
          index: i,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          rsi14: rsi14[i] as number,
          ema12: ema12[i] as number,
          ema26: ema26[i] as number,
          macd: macdResult.macd[i] as number,
          macdSignal: macdResult.signal[i] as number,
          position: state.position,
          equity: spotEquity(state, candle.close),
          cash: state.cash,
          leverage: 1,
        };
        const action = await Promise.resolve(agent.decide(obs));
        const produced = applySpotAction(state, action, i, candle.timestamp, candle.close);
        for (let j = 0; j < produced.length; j++) trades.push(produced[j] as Trade);
      }

      equityCurve[i] = spotEquity(state, candle.close);
    }
  } else {
    const state = newPerpState(opts);
    for (let i = 0; i < n; i++) {
      const candle = candles[i] as {
        timestamp: number; open: number; high: number; low: number; close: number; volume: number;
        fundingRate?: number;
      };

      // 1. Funding accrues at the start of the bar.
      if (candle.fundingRate !== undefined && candle.fundingRate !== 0) {
        accrueFunding(state, candle.open, candle.fundingRate);
      }

      // 2. Liquidation check using the bar's worst-case mark for the position
      //    direction (low for longs, high for shorts).
      if (state.position !== 0) {
        const worstMark = state.position > 0 ? candle.low : candle.high;
        const liq = maybeLiquidate(state, i, candle.timestamp, candle.close, worstMark);
        if (liq) trades.push(liq);
      }

      // 3. SL/TP intra-bar check (skipped if liquidation already closed the position).
      if (state.position !== 0) {
        const trig = checkIntraBar(
          candle,
          perpSLTPLevels(state),
          state.position > 0 ? 1 : -1,
        );
        if (trig) {
          const t = perpForceCloseAt(state, trig.fillPrice, trig.kind, i, candle.timestamp);
          if (t) trades.push(t);
        }
      }

      // 4. Agent decision at close.
      if (i >= WARMUP) {
        const obs: Observation = {
          timestamp: candle.timestamp,
          index: i,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          rsi14: rsi14[i] as number,
          ema12: ema12[i] as number,
          ema26: ema26[i] as number,
          macd: macdResult.macd[i] as number,
          macdSignal: macdResult.signal[i] as number,
          position: state.position,
          equity: perpEquity(state, candle.close),
          cash: state.cash,
          leverage: state.leverage,
        };
        const action = await Promise.resolve(agent.decide(obs));
        const produced = applyPerpAction(state, action, i, candle.timestamp, candle.close);
        for (let j = 0; j < produced.length; j++) trades.push(produced[j] as Trade);
      }

      equityCurve[i] = perpEquity(state, candle.close);
    }
  }

  const metrics = computeMetrics({
    initialBalance: opts.initialBalance,
    equityCurve,
    trades,
    barsPerYear: resolveBarsPerYear(dataset.meta.granularity),
  });

  const agentHash = hashAgent(agent);
  const optionsHash = hashOptions(opts);
  const tradesHash = hashTrades(trades);
  const runHash = composeRunHash(agentHash, dataset.datasetHash, optionsHash, tradesHash);

  return {
    runHash,
    agentHash,
    datasetHash: dataset.datasetHash,
    optionsHash,
    tradesHash,
    trades,
    equityCurve,
    metrics,
    options: opts,
    market: opts.market,
  };
}

/** Re-export for SpotState/PerpState consumers if they want it. */
export type AnyState = SpotState | PerpState;
