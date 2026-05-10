// Public surface — see CLAUDE.md §7. Locked down on day 1; do not break.

export { ZeroArena } from './ZeroArena.js';
export { Agent } from './agent/Agent.js';

export type {
  Action,
  BacktestOptions,
  BacktestResult,
  Candle,
  Certificate,
  Dataset,
  DatasetMeta,
  Direction,
  INFT,
  Market,
  Metrics,
  Observation,
  Side,
  Trade,
  TradeReason,
  TransferResult,
  TrustTier,
  ZeroArenaConfig,
} from './types.js';

// Lower-level primitives — exported so example scripts and the CLI can use them
// directly without going through the full ZeroArena facade.
export { runBacktest, WARMUP } from './backtest/BacktestEngine.js';
export {
  composeRunHash,
  hashAgent,
  hashJson,
  hashOptions,
  hashTrades,
  stableStringify,
} from './backtest/hash.js';
export { ema, macd, rsi } from './backtest/indicators.js';
export { computeMetrics } from './backtest/metrics.js';
