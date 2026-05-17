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

// Onboard — operator-delegation client for zero-arena-be's `onboard` endpoint.
export type {
  OnboardClient,
  OnboardParams,
  OffboardParams,
  OnboardResult,
  OffboardResult,
  OnboardHealth,
  OnboardStatus,
  MessageSigner,
  SignedOnboardPayload,
  OnboardAction,
} from './onboard/OnboardClient.js';
export { digestForOnboard } from './onboard/OnboardClient.js';
export {
  HttpOnboardClient,
  type HttpOnboardClientConfig,
} from './onboard/HttpOnboardClient.js';
export { encryptAgentSource, type EncryptedAgentBundle } from './onboard/crypto.js';

export { runBacktest, WARMUP } from './backtest/BacktestEngine.js';
// Paper trading (RFC-001) — bar-by-bar engine + streaming indicator state.
export { PaperEngine, PAPER_WARMUP, effectivePaperWarmup } from './backtest/PaperEngine.js';
export {
  StreamingIndicators,
  type StreamingObservation,
} from './backtest/streaming-indicators.js';

// Re-export the small subset of ethers primitives that downstream consumers
// (e.g. zero-arena-bacend's paper-engine daemon) need. Avoids forcing every
// consumer to add ethers as a direct dependency just to keccak a buffer.
export { keccak256, toUtf8Bytes } from 'ethers';
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
