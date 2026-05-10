// Public facade for the SDK. The deterministic backtest path is fully wired in
// v0.1 day-1; storage, certify, and mint are stubbed pending the chain/storage
// adapter wiring on days 3-5 of CLAUDE.md §10.

import type {
  BacktestOptions,
  BacktestResult,
  Certificate,
  Dataset,
  INFT,
  TransferResult,
  ZeroArenaConfig,
} from './types.js';
import type { Agent } from './agent/Agent.js';
import { runBacktest } from './backtest/BacktestEngine.js';

export class ZeroArena {
  readonly config: ZeroArenaConfig;

  constructor(config: ZeroArenaConfig) {
    if (!config.rpc || !config.indexer || !config.privateKey) {
      throw new Error('ZeroArenaConfig requires rpc, indexer, and privateKey');
    }
    this.config = config;
  }

  /**
   * Upload an OHLCV CSV to 0G Storage and return a `Dataset` handle.
   * Wired in day 3 — see CLAUDE.md §10.
   */
  async uploadDataset(_csvPath: string): Promise<Dataset> {
    throw new Error('uploadDataset: 0G Storage adapter not yet wired (day 3 of build plan)');
  }

  /**
   * Load a previously-uploaded dataset by its 0G Storage root.
   * Wired in day 3.
   */
  async loadDataset(_opts: { rootHash: string }): Promise<Dataset> {
    throw new Error('loadDataset: 0G Storage adapter not yet wired (day 3 of build plan)');
  }

  /**
   * Run a deterministic backtest and return the result + canonical `runHash`.
   * Fully implemented — this is the deterministic core of the verification protocol.
   */
  async backtest(agent: Agent, dataset: Dataset, opts: BacktestOptions): Promise<BacktestResult> {
    return runBacktest(agent, dataset, opts);
  }

  /**
   * Encrypt the run log, upload to 0G Storage, and submit a certificate on-chain.
   * Wired in days 3-4.
   */
  async certify(_result: BacktestResult): Promise<Certificate> {
    throw new Error('certify: chain/storage adapters not yet wired (days 3-4 of build plan)');
  }

  /**
   * Mint a passing certificate as an ERC-7857 iNFT.
   * Wired in day 5.
   */
  async mintAgent(_opts: {
    agent: Agent;
    certificate: Certificate;
    name: string;
    description?: string;
  }): Promise<INFT> {
    throw new Error('mintAgent: iNFT adapter not yet wired (day 5 of build plan)');
  }

  /**
   * Transfer an iNFT via the ERC-7857 oracle re-encryption flow.
   * Wired in day 5.
   */
  async transferAgent(_opts: {
    tokenId: bigint;
    to: string;
    recipientPubKey: string;
  }): Promise<TransferResult> {
    throw new Error('transferAgent: transfer adapter not yet wired (day 5 of build plan)');
  }
}
