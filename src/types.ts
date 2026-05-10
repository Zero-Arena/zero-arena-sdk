// Public types — locked down per CLAUDE.md §7. Breaking changes here are breaking
// changes for every downstream consumer.

/** Trade side. Spot is long-only in v0.1; perp supports both. */
export type Side = 'buy' | 'sell';

/** Trading direction. -1 short, 0 flat, +1 long. */
export type Direction = -1 | 0 | 1;

/** Market type. Determines portfolio math. */
export type Market = 'spot' | 'perp';

/** Trust tier the certificate was issued under — see CLAUDE.md §3. */
export type TrustTier = 'T1' | 'T2' | 'T3';

/** Reason a trade was emitted. Used for analytics + run-log forensics. */
export type TradeReason = 'open' | 'close' | 'flip' | 'liquidation';

/** A single OHLCV bar. `fundingRate` is set on perp candles where 8h funding accrues. */
export interface Candle {
  /** Unix epoch milliseconds. */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Per-bar funding rate, populated only on perp candles where funding is paid. */
  fundingRate?: number;
}

/** Metadata describing a dataset's provenance. */
export interface DatasetMeta {
  /** Base asset symbol, e.g. "BTC", "0G". */
  asset: string;
  /** Quote asset symbol, e.g. "USDT". */
  quote: string;
  /** Market type the candles describe. */
  market: Market;
  /** Candle granularity, e.g. "1h". */
  granularity: string;
  /** Source identifier, e.g. "binance" or "dex:<aggregator>". */
  source: string;
  /** Earliest candle timestamp (ms). */
  startTs: number;
  /** Latest candle timestamp (ms). */
  endTs: number;
}

/** A loaded dataset — the unit a backtest consumes. */
export interface Dataset {
  /** 0G Storage root hash, or a local-fingerprint sentinel for unsynced datasets. */
  rootHash: string;
  /** Canonical hash of the CSV bytes — the cryptographic identity of the dataset. */
  datasetHash: string;
  /** Raw candles in chronological order. */
  candles: Candle[];
  meta: DatasetMeta;
}

/** Snapshot of market + portfolio state passed to `Agent.decide`. */
export interface Observation {
  /** Candle timestamp (ms). Use this — never `Date.now()`. */
  timestamp: number;
  /** Index of the current candle in the dataset. */
  index: number;

  // Current bar OHLCV.
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;

  // Pre-computed deterministic indicators. All fully warm by the time the agent sees them.
  rsi14: number;
  ema12: number;
  ema26: number;
  macd: number;
  macdSignal: number;

  // Current portfolio snapshot. Updated each bar before `decide` is called.
  /** Position in base units. Signed: positive long, negative short. Always 0 or positive on spot. */
  position: number;
  /** Total equity in quote currency (cash + unrealized PnL). */
  equity: number;
  /** Available cash in quote currency. */
  cash: number;
  /** Current leverage (perp only; 1 on spot). */
  leverage: number;
}

/** Agent decision returned from `decide`. */
export interface Action {
  /** Target direction. */
  direction: Direction;
  /**
   * Fraction of equity to allocate to the position, in [0, 1].
   * Notional traded = equity * size * leverage. size=0 implies "go flat".
   */
  size: number;
}

/** Backtest configuration. */
export interface BacktestOptions {
  /** Initial cash in quote currency. */
  initialBalance: number;
  /** Market mode. Must match the dataset's market. */
  market: Market;
  /** Perp leverage — ignored on spot. Capped at 10 in v0.1. Default 1. */
  leverage?: number;
  /** Taker fee in basis points. Default 10 (0.10%). */
  feeBps?: number;
  /** Slippage applied per fill in basis points. Default 5 (0.05%). */
  slippageBps?: number;
  /** Maintenance margin (perp only) in basis points of notional. Default 500 (5%). */
  liquidationMarginBps?: number;
}

/** A single executed trade. */
export interface Trade {
  /** Candle index this trade executed against. */
  index: number;
  /** Candle timestamp (ms). */
  timestamp: number;
  side: Side;
  /** Fill price (close * (1 ± slippage)). */
  price: number;
  /** Position change in base units (always positive). */
  size: number;
  /** Fee paid, in quote currency. */
  fee: number;
  /** Why the engine emitted this trade. */
  reason: TradeReason;
}

/** Aggregate metrics computed from the equity curve and trade log. */
export interface Metrics {
  /** Total return in basis points (signed). +500 = +5%. */
  totalReturnBps: number;
  /** Annualized Sharpe ratio × 1000, rounded. */
  sharpeX1000: number;
  /** Maximum peak-to-trough drawdown in basis points (unsigned). */
  maxDrawdownBps: number;
  /** Win rate of closed trades, in basis points. */
  winRateBps: number;
  /** Number of executed trades. */
  numTrades: number;
  /** Final equity in quote currency. */
  finalEquity: number;
}

/** Output of `ZeroArena.backtest`. */
export interface BacktestResult {
  /** Canonical hash committing to (agent, dataset, options, trades). */
  runHash: string;
  /** Hash of the agent's `toJSON()` output. */
  agentHash: string;
  /** Inherited from the dataset. */
  datasetHash: string;
  /** Hash of the canonical-encoded options. */
  optionsHash: string;
  /** Hash of the canonical-encoded trade list. */
  tradesHash: string;

  trades: Trade[];
  /** Per-candle equity in quote currency. Same length as the dataset. */
  equityCurve: number[];
  metrics: Metrics;
  options: BacktestOptions;
  market: Market;
}

/** On-chain certificate descriptor returned by `ZeroArena.certify`. */
export interface Certificate {
  certId: bigint;
  runHash: string;
  storageRootHash: string;
  datasetHash: string;
  attestationHash: string; // 0x0 in v0.1 (T1/T2)
  trustTier: TrustTier;
  market: Market;
  metrics: Metrics;
  txHash: string;
}

/** ERC-7857 iNFT descriptor returned by `ZeroArena.mintAgent`. */
export interface INFT {
  tokenId: bigint;
  owner: string;
  certificateId: bigint;
  metadataHash: string;
  storageRoot: string;
  txHash: string;
}

/** Result of an oracle-attested transfer. */
export interface TransferResult {
  tokenId: bigint;
  from: string;
  to: string;
  newMetadataHash: string;
  txHash: string;
}

/** Constructor config for `ZeroArena`. */
export interface ZeroArenaConfig {
  /** 0G Chain RPC URL. */
  rpc: string;
  /** 0G Storage indexer URL. */
  indexer: string;
  /** Signer private key (hex). */
  privateKey: string;
  /** Optional contract address overrides; otherwise read from @zero-arena/contracts. */
  addresses?: {
    AgentCertificate?: string;
    ZeroArenaINFT?: string;
    ReencryptionOracle?: string;
  };
  /**
   * Oracle service private key. Required only for `transferAgent`. In v0.1
   * the off-chain oracle is a trusted-signer stub (CLAUDE.md §3, §8); whoever
   * runs the demo holds the same private key the on-chain ReencryptionOracle
   * was deployed with. v0.2 swaps this for a TEE-attested service.
   */
  oraclePrivateKey?: string;
  /** Override where AES keys are persisted. Defaults to `~/.zeroarena/keys`. */
  keysDir?: string;
}
