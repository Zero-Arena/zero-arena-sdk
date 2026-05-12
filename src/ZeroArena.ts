// Public facade for the SDK. Composes the storage / chain / iNFT adapters
// behind the API documented in CLAUDE.md 7.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { keccak256 } from 'ethers';
import type {
  BacktestOptions,
  BacktestResult,
  Certificate,
  Dataset,
  INFT,
  TransferResult,
  TrustTier,
  ZeroArenaConfig,
} from './types.js';
import type { Agent } from './agent/Agent.js';
import { runBacktest } from './backtest/BacktestEngine.js';
import { stableStringify } from './backtest/hash.js';
import { ChainAdapter, type ChainAddresses } from './chain/ChainAdapter.js';
import { StorageAdapter, makeStorageConfig } from './storage/StorageAdapter.js';
import { encrypt, generateKey } from './storage/encryption.js';
import { MintAdapter, persistKey } from './inft/MintAdapter.js';
import { TransferAdapter } from './inft/TransferAdapter.js';

export interface CertifyOptions {
  /** Trust tier to claim. v0.1 supports T1 + T2; defaults to T2. */
  trustTier?: TrustTier;
  /** Reserved for v0.2 T3 quotes. */
  attestationHash?: string;
}

export class ZeroArena {
  readonly config: ZeroArenaConfig;
  private readonly storage: StorageAdapter;
  private readonly chain: ChainAdapter;
  private readonly mintAdapter: MintAdapter;

  constructor(config: ZeroArenaConfig) {
    if (!config.rpc || !config.indexer || !config.privateKey) {
      throw new Error('ZeroArenaConfig requires rpc, indexer, and privateKey');
    }
    this.config = config;

    const addresses = resolveAddresses(config);
    this.storage = new StorageAdapter(makeStorageConfig(config));
    this.chain = new ChainAdapter({
      rpc: config.rpc,
      privateKey: config.privateKey,
      addresses,
    });
    this.mintAdapter = new MintAdapter(this.storage, this.chain);
  }

  /** Upload an OHLCV CSV to 0G Storage and return a `Dataset` handle. */
  async uploadDataset(csvPath: string): Promise<Dataset> {
    return this.storage.uploadDataset(csvPath);
  }

  /** Load a previously-uploaded dataset by its 0G Storage root. */
  async loadDataset(opts: { rootHash: string }): Promise<Dataset> {
    return this.storage.loadDataset(opts.rootHash);
  }

  /** Run a deterministic backtest. */
  async backtest(agent: Agent, dataset: Dataset, opts: BacktestOptions): Promise<BacktestResult> {
    return runBacktest(agent, dataset, opts);
  }

  /**
   * Encrypt the run log, upload to 0G Storage, and submit a certificate
   * on-chain. Default trust tier is T2 (v0.1). The encryption key is
   * persisted to `<keysDir>/runlog-<runHash>.key` (mode 0600).
   */
  async certify(result: BacktestResult, opts: CertifyOptions = {}): Promise<Certificate> {
    const trustTier: TrustTier = opts.trustTier ?? 'T2';
    if (trustTier === 'T3' && !opts.attestationHash) {
      throw new Error(
        'certify: trustTier T3 requires an attestationHash. v0.1 only supports T1 + T2 — see CLAUDE.md 3.',
      );
    }

    const runLog = buildRunLog(result);
    const plaintext = Buffer.from(stableStringify(runLog), 'utf8');
    const key = generateKey();
    const envelope = encrypt(plaintext, key);
    const { rootHash: storageRootHash } = await this.storage.uploadBytes(envelope);

    await persistKey({
      keysDir: this.config.keysDir,
      tokenId: BigInt('0x' + result.runHash.slice(2, 18)), // truncated for filename
      key,
    });

    return this.chain.submitCertificate({
      result,
      storageRootHash,
      trustTier,
      ...(opts.attestationHash !== undefined ? { attestationHash: opts.attestationHash } : {}),
    });
  }

  /** Mint a passing certificate as an ERC-7857 iNFT. */
  async mintAgent(opts: {
    agent: Agent;
    certificate: Certificate;
    name: string;
    description?: string;
  }): Promise<INFT> {
    const mintInput: Parameters<MintAdapter['mint']>[0] = {
      agent: opts.agent,
      certificate: opts.certificate,
      name: opts.name,
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(this.config.keysDir !== undefined ? { keysDir: this.config.keysDir } : {}),
    };
    return this.mintAdapter.mint(mintInput);
  }

  /** Transfer an iNFT via the ERC-7857 oracle re-encryption flow. */
  async transferAgent(opts: {
    tokenId: bigint;
    to: string;
    recipientPubKey: string;
  }): Promise<TransferResult> {
    if (!this.config.oracle) {
      throw new Error(
        'transferAgent: ZeroArenaConfig.oracle is required. Construct an HttpOracleClient ' +
          "pointing at a deployed oracle service (see zero-arena-bacend's `oracle:serve`), " +
          'or a LocalOracleClient if you operate the oracle. The SDK never holds an ' +
          'oracle private key.',
      );
    }
    const keysDir = this.config.keysDir ?? join(homedir(), '.zeroarena', 'keys');
    const transfer = new TransferAdapter(this.storage, this.chain, {
      oracle: this.config.oracle,
      currentKeyPath: join(keysDir, `agent-${opts.tokenId.toString()}.key`),
    });
    const from = await this.chain.signerAddress();
    return transfer.transfer({
      tokenId: opts.tokenId,
      from,
      to: opts.to,
      recipientPubKey: opts.recipientPubKey,
    });
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

function resolveAddresses(cfg: ZeroArenaConfig): ChainAddresses {
  const a = cfg.addresses ?? {};
  if (!a.AgentCertificate || !a.ZeroArenaINFT || !a.ReencryptionOracle) {
    throw new Error(
      'ZeroArenaConfig.addresses must include AgentCertificate, ZeroArenaINFT, and ReencryptionOracle. ' +
      'After deploying the contracts, copy them from contracts/deployments/galileo-testnet.json.',
    );
  }
  return {
    AgentCertificate: a.AgentCertificate,
    ZeroArenaINFT: a.ZeroArenaINFT,
    ReencryptionOracle: a.ReencryptionOracle,
  };
}

interface RunLog {
  schema: 'zeroarena.runlog.v1';
  runHash: string;
  agentHash: string;
  datasetHash: string;
  optionsHash: string;
  tradesHash: string;
  options: BacktestOptions;
  market: 'spot' | 'perp';
  trades: BacktestResult['trades'];
  equityCurve: number[];
  metricsHash: string;
}

function buildRunLog(result: BacktestResult): RunLog {
  return {
    schema: 'zeroarena.runlog.v1',
    runHash: result.runHash,
    agentHash: result.agentHash,
    datasetHash: result.datasetHash,
    optionsHash: result.optionsHash,
    tradesHash: result.tradesHash,
    options: result.options,
    market: result.market,
    trades: result.trades,
    equityCurve: result.equityCurve,
    metricsHash: keccak256(Buffer.from(stableStringify(result.metrics), 'utf8')),
  };
}
