// Ethers v6 wrapper around the three Zero Arena contracts. The adapter knows
// how to: submit a certificate, mint an iNFT, transfer an iNFT, and read back
// any of the on-chain state the SDK needs. It does not know anything about
// 0G Storage — the storage root is passed in.

import {
  Contract,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  getBytes,
  hexlify,
  type Signer,
  type TransactionReceipt,
} from 'ethers';
import type {
  BacktestResult,
  Certificate,
  INFT,
  Market,
  Metrics,
  TransferResult,
  TrustTier,
} from '../types.js';
import {
  AGENT_CERTIFICATE_ABI,
  REENCRYPTION_ORACLE_ABI,
  ZERO_ARENA_INFT_ABI,
  marketFromByte,
  marketToByte,
  trustTierToByte,
} from './abi.js';

export interface ChainAddresses {
  AgentCertificate: string;
  ZeroArenaINFT: string;
  ReencryptionOracle: string;
}

export interface ChainConfig {
  rpc: string;
  privateKey: string;
  addresses: ChainAddresses;
  /**
   * Optional override for the legacy `gasPrice` (wei) applied to every tx.
   * Galileo testnet rejects EIP-1559 envelopes with priority < 2 gwei, so
   * the SDK defaults to a 3 gwei legacy gasPrice when the connected chain
   * looks like Galileo (chainId 16602). Set explicitly to skip the heuristic
   * (e.g. 0n disables overrides for compatible chains).
   */
  gasPriceOverride?: bigint;
}

export interface SubmitCertificateInput {
  result: BacktestResult;
  storageRootHash: string; // 0x-hex bytes32 — root of the encrypted run-log envelope
  trustTier?: TrustTier; // defaults to T2 in v0.1 per CLAUDE.md 3
  attestationHash?: string; // 0x0 unless trustTier === 'T3'
}

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

const UINT16_MAX = 65_535;
const INT128_MAX = (1n << 127n) - 1n;
const INT128_MIN = -(1n << 127n);

/** Galileo testnet chain ID. Triggers the legacy gas-price default. */
const GALILEO_CHAIN_ID = 16_602n;
/** 3 gwei = above Galileo's 2-gwei priority floor. */
const GALILEO_LEGACY_GAS_PRICE = 3_000_000_000n;

export class ChainAdapter {
  private readonly signer: Signer;
  private readonly cert: Contract;
  private readonly inft: Contract;
  private readonly oracle: Contract;
  private readonly provider: JsonRpcProvider;
  /** Lazy-resolved legacy gasPrice override. `null` = use ethers default. */
  private cachedTxOverrides: { gasPrice?: bigint } | null = null;

  constructor(public readonly cfg: ChainConfig) {
    assertAddress(cfg.addresses.AgentCertificate, 'AgentCertificate');
    assertAddress(cfg.addresses.ZeroArenaINFT, 'ZeroArenaINFT');
    assertAddress(cfg.addresses.ReencryptionOracle, 'ReencryptionOracle');

    this.provider = new JsonRpcProvider(cfg.rpc);
    this.signer = new Wallet(cfg.privateKey, this.provider);
    this.cert = new Contract(cfg.addresses.AgentCertificate, AGENT_CERTIFICATE_ABI, this.signer);
    this.inft = new Contract(cfg.addresses.ZeroArenaINFT, ZERO_ARENA_INFT_ABI, this.signer);
    this.oracle = new Contract(cfg.addresses.ReencryptionOracle, REENCRYPTION_ORACLE_ABI, this.signer);
  }

  /**
   * Resolve the per-tx `{ gasPrice }` override once and cache. Galileo testnet
   * rejects EIP-1559 envelopes with priority < 2 gwei; on that chain we send
   * legacy 3 gwei. On other chains we let ethers pick fees.
   */
  private async txOverrides(): Promise<{ gasPrice?: bigint }> {
    if (this.cachedTxOverrides) return this.cachedTxOverrides;

    if (this.cfg.gasPriceOverride !== undefined) {
      this.cachedTxOverrides = this.cfg.gasPriceOverride > 0n
        ? { gasPrice: this.cfg.gasPriceOverride }
        : {};
      return this.cachedTxOverrides;
    }

    try {
      const net = await this.provider.getNetwork();
      this.cachedTxOverrides = net.chainId === GALILEO_CHAIN_ID
        ? { gasPrice: GALILEO_LEGACY_GAS_PRICE }
        : {};
    } catch {
      // Network lookup failed (offline tests etc.) — fall back to default.
      this.cachedTxOverrides = {};
    }
    return this.cachedTxOverrides;
  }

  /** Address the SDK is signing transactions from. */
  async signerAddress(): Promise<string> {
    return this.signer.getAddress();
  }

  /** Returns the underlying signer; needed by storage uploads that pay 0G fees. */
  getSigner(): Signer {
    return this.signer;
  }

  // ─── certificate ────────────────────────────────────────────────────────

  /**
   * Submit a backtest result on-chain. Returns the populated `Certificate`
   * descriptor (certId comes from the emitted event).
   */
  async submitCertificate(input: SubmitCertificateInput): Promise<Certificate> {
    const trustTier: TrustTier = input.trustTier ?? 'T2';
    const attestationHash = input.attestationHash ?? ZERO_BYTES32;
    if (trustTier === 'T3' && attestationHash === ZERO_BYTES32) {
      throw new Error('submitCertificate: trustTier T3 requires an attestationHash');
    }
    if (trustTier !== 'T3' && attestationHash !== ZERO_BYTES32) {
      throw new Error('submitCertificate: only T3 may carry an attestationHash');
    }

    const m = input.result.metrics;
    const totalReturn = clampInt128(BigInt(Math.round(m.totalReturnBps)));
    const sharpe = clampUint128(BigInt(Math.max(0, Math.round(m.sharpeX1000))));
    const maxDD = clampUint16(Math.max(0, Math.round(m.maxDrawdownBps)));
    const winRate = clampUint16(Math.max(0, Math.round(m.winRateBps)));

    const overrides = await this.txOverrides();
    const tx = await this.cert.submit!(
      input.result.runHash,
      input.storageRootHash,
      input.result.datasetHash,
      attestationHash,
      totalReturn,
      sharpe,
      maxDD,
      winRate,
      trustTierToByte(trustTier),
      marketToByte(input.result.market),
      overrides,
    );
    const receipt = (await tx.wait()) as TransactionReceipt;
    const certId = parseCertSubmittedEvent(receipt, this.cert);

    return {
      certId,
      runHash: input.result.runHash,
      storageRootHash: input.storageRootHash,
      datasetHash: input.result.datasetHash,
      attestationHash,
      trustTier,
      market: input.result.market,
      metrics: input.result.metrics,
      txHash: receipt.hash,
    };
  }

  /** Read a certificate by id. */
  async getCertificate(certId: bigint): Promise<{
    runHash: string;
    storageRootHash: string;
    datasetHash: string;
    attestationHash: string;
    owner: string;
    createdAt: number;
    trustTier: TrustTier;
    market: Market;
    metrics: Pick<Metrics, 'totalReturnBps' | 'sharpeX1000' | 'maxDrawdownBps' | 'winRateBps'>;
  }> {
    const c = await this.cert.get!(certId);
    return {
      runHash: c.runHash as string,
      storageRootHash: c.storageRootHash as string,
      datasetHash: c.datasetHash as string,
      attestationHash: c.attestationHash as string,
      owner: c.owner as string,
      createdAt: Number(c.createdAt),
      trustTier: byteToTier(Number(c.trustTier)),
      market: marketFromByte(Number(c.market)),
      metrics: {
        totalReturnBps: Number(c.totalReturnBps),
        sharpeX1000: Number(c.sharpeX1000),
        maxDrawdownBps: Number(c.maxDrawdownBps),
        winRateBps: Number(c.winRateBps),
      },
    };
  }

  // ─── iNFT mint ──────────────────────────────────────────────────────────

  async mintAgent(input: {
    certificateId: bigint;
    metadataHash: string;
    storageRoot: string;
  }): Promise<INFT> {
    const overrides = await this.txOverrides();
    const tx = await this.inft.mint!(
      input.certificateId,
      input.metadataHash,
      input.storageRoot,
      overrides,
    );
    const receipt = (await tx.wait()) as TransactionReceipt;
    const tokenId = parseAgentMintedEvent(receipt, this.inft);
    const owner = await this.signerAddress();
    return {
      tokenId,
      owner,
      certificateId: input.certificateId,
      metadataHash: input.metadataHash,
      storageRoot: input.storageRoot,
      txHash: receipt.hash,
    };
  }

  // ─── iNFT transfer (ERC-7857) ───────────────────────────────────────────

  /**
   * Submit a re-encryption transfer. Caller must have already produced a
   * fresh `sealedKey` + signed `proof` via the off-chain oracle service —
   * see TransferAdapter for the high-level flow.
   */
  async submitTransfer(input: {
    from: string;
    to: string;
    tokenId: bigint;
    sealedKey: Uint8Array;
    proof: Uint8Array;
  }): Promise<TransferResult> {
    const overrides = await this.txOverrides();
    const tx = await this.inft.transfer!(
      input.from,
      input.to,
      input.tokenId,
      hexlify(input.sealedKey),
      hexlify(input.proof),
      overrides,
    );
    const receipt = (await tx.wait()) as TransactionReceipt;
    const newMetadataHash = parseMetadataUpdatedEvent(receipt, this.inft, input.tokenId);
    return {
      tokenId: input.tokenId,
      from: input.from,
      to: input.to,
      newMetadataHash,
      txHash: receipt.hash,
    };
  }

  /** Read the oracle's signer address — useful for transfer flow sanity checks. */
  async oracleSigner(): Promise<string> {
    return (await this.oracle.signer!()) as string;
  }

  /** Read the oracle contract address bound to the iNFT contract on-chain. */
  async inftOracle(): Promise<string> {
    return (await this.inft.oracle!()) as string;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

function assertAddress(addr: string, label: string): void {
  if (!addr || addr === ZeroAddress) {
    throw new Error(
      `ChainAdapter: ${label} address is not configured. Pass addresses in ZeroArenaConfig or deploy contracts first.`,
    );
  }
}

function clampInt128(v: bigint): bigint {
  if (v > INT128_MAX) return INT128_MAX;
  if (v < INT128_MIN) return INT128_MIN;
  return v;
}

function clampUint128(v: bigint): bigint {
  if (v < 0n) return 0n;
  return v;
}

function clampUint16(v: number): number {
  if (v < 0) return 0;
  if (v > UINT16_MAX) return UINT16_MAX;
  return v;
}

function byteToTier(b: number): TrustTier {
  if (b === 1) return 'T1';
  if (b === 2) return 'T2';
  if (b === 3) return 'T3';
  throw new Error(`byteToTier: unknown tier byte ${b}`);
}

function parseCertSubmittedEvent(receipt: TransactionReceipt, cert: Contract): bigint {
  const iface = cert.interface;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === 'CertificateSubmitted') {
        return parsed.args.getValue('certId') as bigint;
      }
    } catch {
      // Not from our ABI — ignore.
    }
  }
  throw new Error('submitCertificate: CertificateSubmitted event not found in receipt');
}

function parseAgentMintedEvent(receipt: TransactionReceipt, inft: Contract): bigint {
  const iface = inft.interface;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === 'AgentMinted') {
        return parsed.args.getValue('tokenId') as bigint;
      }
    } catch {
      // Not from our ABI — ignore.
    }
  }
  throw new Error('mintAgent: AgentMinted event not found in receipt');
}

function parseMetadataUpdatedEvent(
  receipt: TransactionReceipt,
  inft: Contract,
  tokenId: bigint,
): string {
  const iface = inft.interface;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === 'MetadataUpdated') {
        const id = parsed.args.getValue('tokenId') as bigint;
        if (id === tokenId) {
          return parsed.args.getValue('newMetadataHash') as string;
        }
      }
    } catch {
      // Not from our ABI — ignore.
    }
  }
  // Not all transfers update metadata (if the new hash equals the old one),
  // so fall back to reading the on-chain state directly.
  return ZERO_BYTES32;
}

/** Helper for callers that need to convert a raw hex root to bytes32-ish strings. */
export function ensureBytes32(hex: string): string {
  const b = getBytes(hex);
  if (b.length !== 32) throw new Error(`ensureBytes32: expected 32 bytes, got ${b.length}`);
  return hexlify(b);
}
