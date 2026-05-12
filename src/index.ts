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

// Oracle abstraction — the SDK NEVER holds the oracle private key itself.
// Consumers explicitly construct a client (Http for production, Local for
// dev/demo operators) and pass it via `ZeroArenaConfig.oracle`.
export type { OracleClient, TransferProofRequest } from './inft/OracleClient.js';
export { oracleDigest } from './inft/OracleClient.js';
export { HttpOracleClient, type HttpOracleClientConfig } from './inft/HttpOracleClient.js';
export { LocalOracleClient, type LocalOracleClientConfig } from './inft/LocalOracleClient.js';

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
