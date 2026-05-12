// Public surface — see CLAUDE.md 7. Locked down on day 1; do not break.

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

export type { OracleClient, TransferProofRequest } from './inft/OracleClient.js';
export { oracleDigest } from './inft/OracleClient.js';
export { HttpOracleClient, type HttpOracleClientConfig } from './inft/HttpOracleClient.js';
export { LocalOracleClient, type LocalOracleClientConfig } from './inft/LocalOracleClient.js';

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

import { StorageAdapter as _StorageAdapterImpl } from './storage/StorageAdapter.js';
export const parseDatasetFile = _StorageAdapterImpl.parseDatasetFile.bind(_StorageAdapterImpl);
export { StorageAdapter } from './storage/StorageAdapter.js';

export { loadEnv, configFromEnv, type ResolvedConfig } from './cli/env.js';

export { CANONICAL_DATASETS, type CanonicalDataset } from './datasets.js';
