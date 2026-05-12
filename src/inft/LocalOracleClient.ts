// LocalOracleClient — signs the transfer proof in the SAME process as the
// SDK, using a private key the caller hands in explicitly.
//
// Use this ONLY if you operate the deployed `ReencryptionOracle` contract
// yourself (e.g., end-to-end demo runs, integration tests). In production
// the oracle key must live in a separate, isolated process — point an
// `HttpOracleClient` at it instead.
//
// We deliberately do not auto-load this from environment variables: making
// the call site read `new LocalOracleClient({ privateKey: ... })` is the
// guardrail that prevents the "every SDK user knows the oracle key"
// architecture mistake.

import { Wallet, getBytes } from 'ethers';
import type { OracleClient, TransferProofRequest } from './OracleClient.js';
import { oracleDigest } from './OracleClient.js';

export interface LocalOracleClientConfig {
  /** Private key the on-chain `ReencryptionOracle.signer()` resolves to. */
  privateKey: string;
}

export class LocalOracleClient implements OracleClient {
  private readonly wallet: Wallet;

  constructor(config: LocalOracleClientConfig) {
    if (!config.privateKey || !config.privateKey.startsWith('0x')) {
      throw new Error('LocalOracleClient: privateKey must be a 0x-prefixed hex string');
    }
    this.wallet = new Wallet(config.privateKey);
  }

  async signTransferProof(req: TransferProofRequest): Promise<string> {
    return this.wallet.signMessage(getBytes(oracleDigest(req)));
  }

  /** Address derived from the held key — useful for sanity-checking against the on-chain `signer()`. */
  get address(): string {
    return this.wallet.address;
  }
}
