// 0G Storage adapter — wraps @0gfoundation/0g-storage-ts-sdk for the two
// patterns Zero Arena needs:
//   1. Public dataset upload/download (CSV bytes, hashed with keccak256).
//   2. Private artifact upload/download (run logs, agent metadata) where the
//      bytes are AES-256-GCM encrypted before they leave the host.
//
// The adapter is intentionally thin: there is no caching, no retry logic
// beyond what the underlying SDK already does. Callers (ZeroArena facade,
// CLI commands, examples) compose these primitives.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Indexer, MemData } from '@0gfoundation/0g-storage-ts-sdk';
import { JsonRpcProvider, Wallet, keccak256, getBytes, type Signer } from 'ethers';
import type { Candle, Dataset, DatasetMeta } from '../types.js';
import { decrypt, encrypt, generateKey } from './encryption.js';

export interface StorageConfig {
  /** 0G Storage indexer URL — `https://indexer-storage-turbo.0g.ai`. */
  indexerUrl: string;
  /** 0G mainnet RPC the indexer uses for fee submission — `https://evmrpc.0g.ai`. */
  evmRpc: string;
  /** Signer with gas balance to pay storage fees. */
  signer: Signer;
}

export interface UploadReceipt {
  rootHash: string;
  txHash: string;
}

export interface EncryptedUploadReceipt extends UploadReceipt {
  /** 32-byte AES key used to encrypt this artifact. Hold tightly. */
  key: Buffer;
}

const META_PREFIX = '# meta:';

/**
 * Build the StorageConfig from raw RPC + private-key strings — the shape
 * `ZeroArenaConfig` exposes. Centralized so the wallet/provider lifecycle
 * is consistent across CLI and library use.
 */
export function makeStorageConfig(opts: {
  rpc: string;
  indexer: string;
  privateKey: string;
}): StorageConfig {
  const provider = new JsonRpcProvider(opts.rpc);
  const signer = new Wallet(opts.privateKey, provider);
  return { indexerUrl: opts.indexer, evmRpc: opts.rpc, signer };
}

export class StorageAdapter {
  private readonly indexer: Indexer;

  constructor(private readonly cfg: StorageConfig) {
    this.indexer = new Indexer(cfg.indexerUrl);
  }

  // ─── raw bytes ──────────────────────────────────────────────────────────

  /** Upload arbitrary bytes. Returns the storage root hash + on-chain tx hash. */
  async uploadBytes(bytes: Uint8Array): Promise<UploadReceipt> {
    const file = new MemData(Buffer.from(bytes));
    const [tree, treeErr] = await file.merkleTree();
    if (treeErr || !tree) {
      throw new Error(`StorageAdapter.uploadBytes: merkleTree failed — ${treeErr?.message ?? 'no tree'}`);
    }
    const rootHash = tree.rootHash();
    if (!rootHash) {
      throw new Error('StorageAdapter.uploadBytes: rootHash() returned null');
    }
    const [tx, err] = await this.indexer.upload(file, this.cfg.evmRpc, this.cfg.signer);
    if (err) {
      throw new Error(`StorageAdapter.uploadBytes: upload failed — ${err.message}`);
    }
    const txHash = 'txHash' in tx ? tx.txHash : (tx.txHashes[0] ?? '');
    return { rootHash, txHash };
  }

  /** Download bytes by storage root. Round-trips via a temp file (SDK requirement). */
  async downloadBytes(rootHash: string): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'za-dl-'));
    const path = join(dir, 'data.bin');
    try {
      const err = await this.indexer.download(rootHash, path, false);
      if (err) {
        throw new Error(`StorageAdapter.downloadBytes: download failed — ${err.message}`);
      }
      return await readFile(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ─── encrypted artifacts ────────────────────────────────────────────────

  /**
   * Encrypt `plaintext` with a freshly-generated AES-256 key and upload the
   * envelope. Returns the rootHash + the key so the caller can reuse / store
   * the key out-of-band (it never leaves this machine in plaintext).
   */
  async uploadEncrypted(plaintext: Uint8Array): Promise<EncryptedUploadReceipt> {
    const key = generateKey();
    const envelope = encrypt(plaintext, key);
    const receipt = await this.uploadBytes(envelope);
    return { ...receipt, key };
  }

  /** Inverse of `uploadEncrypted`. Throws if the envelope is tampered or the key is wrong. */
  async downloadAndDecrypt(rootHash: string, key: Uint8Array): Promise<Buffer> {
    const envelope = await this.downloadBytes(rootHash);
    return decrypt(envelope, key);
  }

  // ─── dataset round-trip ────────────────────────────────────────────────

  /**
   * Upload an OHLCV CSV and return a fully-populated `Dataset`.
   *
   * The file is uploaded verbatim — `datasetHash` is `keccak256(rawBytes)`,
   * which is what every subsequent backtest commits to. Metadata is read
   * from a leading `# meta:{json}` comment line if present; otherwise the
   * caller must supply it.
   */
  async uploadDataset(csvPath: string, fallbackMeta?: DatasetMeta): Promise<Dataset> {
    const bytes = await readFile(csvPath);
    const datasetHash = keccak256(bytes);
    const meta = parseMeta(bytes) ?? fallbackMeta;
    if (!meta) {
      throw new Error(
        `uploadDataset: ${csvPath} has no '# meta:{...}' header line and no fallbackMeta provided`,
      );
    }
    const candles = parseCandles(bytes);
    const { rootHash } = await this.uploadBytes(bytes);
    return { rootHash, datasetHash, candles, meta };
  }

  /** Download a previously-uploaded dataset by its storage root hash. */
  async loadDataset(rootHash: string, fallbackMeta?: DatasetMeta): Promise<Dataset> {
    const bytes = await this.downloadBytes(rootHash);
    const datasetHash = keccak256(bytes);
    const meta = parseMeta(bytes) ?? fallbackMeta;
    if (!meta) {
      throw new Error(`loadDataset: ${rootHash} has no embedded meta and no fallbackMeta provided`);
    }
    const candles = parseCandles(bytes);
    return { rootHash, datasetHash, candles, meta };
  }

  /**
   * Parse a dataset CSV from disk WITHOUT uploading it. Useful for offline
   * backtests against fixture data — `rootHash` is set to a local-fingerprint
   * sentinel `local:<datasetHash>` so consumers can still tell it apart from
   * a real 0G-anchored dataset.
   */
  static async parseDatasetFile(csvPath: string, fallbackMeta?: DatasetMeta): Promise<Dataset> {
    const bytes = await readFile(csvPath);
    const datasetHash = keccak256(bytes);
    const meta = parseMeta(bytes) ?? fallbackMeta;
    if (!meta) {
      throw new Error(`parseDatasetFile: ${csvPath} has no embedded meta and no fallbackMeta`);
    }
    const candles = parseCandles(bytes);
    return { rootHash: `local:${datasetHash}`, datasetHash, candles, meta };
  }

  /**
   * Write a CSV with an embedded meta header line, suitable for passing to
   * `uploadDataset` later. Used by the ingest script in
   * zero-arena-example-agent/00-binance-ingest.
   */
  static async writeCanonicalCsv(
    outPath: string,
    meta: DatasetMeta,
    candles: readonly Candle[],
  ): Promise<{ datasetHash: string }> {
    const header = `${META_PREFIX}${JSON.stringify(meta)}\n`;
    const cols = 'timestamp,open,high,low,close,volume,fundingRate\n';
    const rows = candles.map(canonicalRow).join('\n') + '\n';
    const bytes = Buffer.from(header + cols + rows, 'utf8');
    await writeFile(outPath, bytes);
    return { datasetHash: keccak256(bytes) };
  }
}

// ─── private helpers ─────────────────────────────────────────────────────

function parseMeta(bytes: Buffer): DatasetMeta | undefined {
  const nl = bytes.indexOf(0x0a);
  if (nl < 0) return undefined;
  const first = bytes.subarray(0, nl).toString('utf8').trim();
  if (!first.startsWith(META_PREFIX)) return undefined;
  try {
    return JSON.parse(first.slice(META_PREFIX.length)) as DatasetMeta;
  } catch {
    throw new Error(`parseMeta: malformed '# meta:{...}' header line`);
  }
}

function parseCandles(bytes: Buffer): Candle[] {
  const text = bytes.toString('utf8');
  const lines = text.split('\n');
  const candles: Candle[] = [];
  let sawHeader = false;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    if (!sawHeader && line.toLowerCase().startsWith('timestamp')) {
      sawHeader = true;
      continue;
    }
    const cols = line.split(',');
    if (cols.length < 6) continue;
    const c: Candle = {
      timestamp: Number(cols[0]),
      open: Number(cols[1]),
      high: Number(cols[2]),
      low: Number(cols[3]),
      close: Number(cols[4]),
      volume: Number(cols[5]),
    };
    if (cols.length >= 7 && cols[6] !== undefined && cols[6] !== '') {
      c.fundingRate = Number(cols[6]);
    }
    candles.push(c);
  }
  return candles;
}

function canonicalRow(c: Candle): string {
  return [c.timestamp, c.open, c.high, c.low, c.close, c.volume, c.fundingRate ?? '']
    .map((v) => (typeof v === 'number' ? v.toString() : v))
    .join(',');
}

/** keccak256 with the standard 0x-hex output, exposed for callers that need it. */
export function hashBytes(bytes: Uint8Array): string {
  return keccak256(getBytes(bytes));
}
