// Deterministic backtest loop. The whole verification protocol depends on this
// module producing byte-identical `runHash` values across runs of the same
// (agent, dataset, options) tuple.
//
// Determinism rules — see CLAUDE.md §7:
//  1. No `Math.random` anywhere in the path. (Use a seeded PRNG if ever needed.)
//  2. No `Date.now`. Use `candle.timestamp`.
//  3. No object iteration in the hot path — use arrays + numeric indices.
//  4. Indicators are pre-computed once with fixed iteration order.

import type { Agent } from '../agent/Agent.js';
import type { BacktestOptions, BacktestResult, Dataset, Observation, Trade } from '../types.js';
import { ema, macd, rsi } from './indicators.js';
import { applySpotAction, newSpotState, spotEquity, type SpotState } from './portfolio.js';
import {
  accrueFunding,
  applyPerpAction,
  maybeLiquidate,
  newPerpState,
  perpEquity,
  type PerpState,
} from './perp.js';
import { computeMetrics } from './metrics.js';
import { composeRunHash, hashAgent, hashOptions, hashTrades } from './hash.js';

/** Bars per year for a 1h granularity dataset. */
const BARS_PER_YEAR_1H = 24 * 365;

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
      const candle = candles[i] as { timestamp: number; open: number; high: number; low: number; close: number; volume: number };
      const close = candle.close;

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
          equity: spotEquity(state, close),
          cash: state.cash,
          leverage: 1,
        };
        const action = await Promise.resolve(agent.decide(obs));
        const produced = applySpotAction(state, action, i, candle.timestamp, close);
        for (let j = 0; j < produced.length; j++) trades.push(produced[j] as Trade);
      }

      equityCurve[i] = spotEquity(state, close);
    }
  } else {
    const state = newPerpState(opts);
    for (let i = 0; i < n; i++) {
      const candle = candles[i] as { timestamp: number; open: number; high: number; low: number; close: number; volume: number; fundingRate?: number };
      const close = candle.close;

      // Funding accrues at the start of the bar (using prior close ~ open ≈ close).
      if (candle.fundingRate !== undefined && candle.fundingRate !== 0) {
        accrueFunding(state, close, candle.fundingRate);
      }

      // Margin check on the new bar before the agent acts.
      const liq = maybeLiquidate(state, i, candle.timestamp, close);
      if (liq) trades.push(liq);

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
          equity: perpEquity(state, close),
          cash: state.cash,
          leverage: state.leverage,
        };
        const action = await Promise.resolve(agent.decide(obs));
        const produced = applyPerpAction(state, action, i, candle.timestamp, close);
        for (let j = 0; j < produced.length; j++) trades.push(produced[j] as Trade);
      }

      equityCurve[i] = perpEquity(state, close);
    }
  }

  const metrics = computeMetrics({
    initialBalance: opts.initialBalance,
    equityCurve,
    trades,
    barsPerYear: BARS_PER_YEAR_1H,
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
