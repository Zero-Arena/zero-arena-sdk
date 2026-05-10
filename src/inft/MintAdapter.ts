// MintAdapter — composes StorageAdapter + ChainAdapter to mint an ERC-7857
// iNFT against a passing certificate.
//
// Mint pipeline:
//   1. Build canonical agent metadata (name, description, agentJson, certId, ...).
//   2. Generate a fresh AES-256 key.
//   3. Encrypt the metadata bytes; upload the envelope to 0G Storage.
//   4. metadataHash = keccak256(encryptedEnvelope)  ← content commitment
//      storageRoot  = 0G storage root              ← retrieval pointer
//   5. Call ZeroArenaINFT.mint(certificateId, metadataHash, storageRoot).
//   6. Persist the AES key to `<keysDir>/agent-<tokenId>.key` (mode 0600) so
//      the owner can later decrypt the blob and feed it into the transfer
//      flow.

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { keccak256 } from 'ethers';
import type { Agent } from '../agent/Agent.js';
import type { Certificate, INFT } from '../types.js';
import { stableStringify } from '../backtest/hash.js';
import { encrypt, generateKey, keyToHex } from '../storage/encryption.js';
import { ChainAdapter } from '../chain/ChainAdapter.js';
import { StorageAdapter } from '../storage/StorageAdapter.js';

export interface MintInput {
  agent: Agent;
  certificate: Certificate;
  name: string;
  description?: string;
  /** Override where the AES key is persisted. Defaults to `~/.zeroarena/keys`. */
  keysDir?: string;
}

export interface AgentMetadata {
  schema: 'zeroarena.iNFT.metadata.v1';
  name: string;
  description: string;
  agentJson: Record<string, unknown>;
  certificateId: string; // bigint serialized as decimal string
  runHash: string;
  datasetHash: string;
  market: 'spot' | 'perp';
  trustTier: 'T1' | 'T2' | 'T3';
}

export class MintAdapter {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly chain: ChainAdapter,
  ) {}

  async mint(input: MintInput): Promise<INFT> {
    const meta = buildAgentMetadata(input);
    const plaintext = Buffer.from(stableStringify(meta), 'utf8');

    const key = generateKey();
    const envelope = encrypt(plaintext, key);
    const metadataHash = keccak256(envelope);

    const { rootHash: storageRoot } = await this.storage.uploadBytes(envelope);

    const inft = await this.chain.mintAgent({
      certificateId: input.certificate.certId,
      metadataHash,
      storageRoot,
    });

    await persistKey({
      keysDir: input.keysDir,
      tokenId: inft.tokenId,
      key,
    });

    return inft;
  }
}

/** Build the canonical metadata JSON. Sorted keys + stable encoding. */
export function buildAgentMetadata(input: MintInput): AgentMetadata {
  return {
    schema: 'zeroarena.iNFT.metadata.v1',
    name: input.name,
    description: input.description ?? '',
    agentJson: input.agent.toJSON(),
    certificateId: input.certificate.certId.toString(),
    runHash: input.certificate.runHash,
    datasetHash: input.certificate.datasetHash,
    market: input.certificate.market,
    trustTier: input.certificate.trustTier,
  };
}

export interface PersistKeyInput {
  keysDir?: string;
  tokenId: bigint;
  key: Uint8Array;
}

/**
 * Write a hex-encoded AES key to disk with restricted permissions. The
 * default location is `~/.zeroarena/keys/agent-<tokenId>.key`. The function
 * returns the absolute path it wrote to so callers can surface it to the
 * user.
 */
export async function persistKey(input: PersistKeyInput): Promise<string> {
  const dir = resolve(input.keysDir ?? join(homedir(), '.zeroarena', 'keys'));
  const path = join(dir, `agent-${input.tokenId.toString()}.key`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, keyToHex(input.key) + '\n', { encoding: 'utf8' });
  try {
    await chmod(path, 0o600);
  } catch {
    // Non-POSIX filesystems (Windows) may not support chmod; the warning is
    // documented in RELEASE.md so we don't error out the mint flow here.
  }
  return path;
}
