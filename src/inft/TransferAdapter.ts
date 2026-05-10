// TransferAdapter — drives the ERC-7857 oracle re-encryption flow end-to-end.
//
// Steps (mirroring CLAUDE.md §3 and ZeroArenaINFT.transfer):
//   1. Sender holds K_old (the AES key from the original mint).
//   2. Download the current encrypted blob from 0G Storage (via storageRoot
//      stored on the iNFT contract). Decrypt with K_old.
//   3. Generate a fresh K_new and re-encrypt the plaintext metadata.
//   4. Upload the new envelope; compute newMetadataHash = keccak256(envelope).
//   5. Wrap K_new under the recipient's secp256k1 pubkey → sealedKey.
//   6. Sign the proof tuple with the off-chain oracle's private key
//      (whoever the deployed ReencryptionOracle.signer() points to).
//   7. Submit ZeroArenaINFT.transfer(from, to, tokenId, sealedKey, proof).
//
// V0.1 caveat: this adapter holds the oracle private key in process. That
// is acceptable for the trusted-stub mode — production swaps this for a
// TEE-attested service (CLAUDE.md §14 step 6).

import { readFile } from 'node:fs/promises';
import {
  AbiCoder,
  Contract,
  JsonRpcProvider,
  Wallet,
  getBytes,
  keccak256,
  hexlify,
} from 'ethers';
import type { TransferResult } from '../types.js';
import { decrypt, encrypt, generateKey, keyFromHex } from '../storage/encryption.js';
import { wrapKey } from './ecies.js';
import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { ChainAdapter } from '../chain/ChainAdapter.js';
import { ZERO_ARENA_INFT_ABI } from '../chain/abi.js';

const PROOF_TTL_SECONDS = 3600;

export interface TransferConfig {
  /** Private key of the off-chain oracle service (must match contract.signer). */
  oraclePrivateKey: string;
  /** Path to the file holding the sender's current AES key (mint output). */
  currentKeyPath: string;
  /** Override TTL for the signed proof (seconds). */
  deadlineSec?: number;
}

export interface TransferInput {
  tokenId: bigint;
  from: string;
  to: string;
  /** Recipient's uncompressed secp256k1 pubkey, 0x04…-hex. */
  recipientPubKey: string;
}

export class TransferAdapter {
  private readonly oracle: Wallet;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly chain: ChainAdapter,
    private readonly cfg: TransferConfig,
  ) {
    this.oracle = new Wallet(cfg.oraclePrivateKey);
  }

  async transfer(input: TransferInput): Promise<TransferResult> {
    // 1. Read K_old.
    const kOldHex = (await readFile(this.cfg.currentKeyPath, 'utf8')).trim();
    const kOld = keyFromHex(kOldHex);

    // 2. Pull the current storage root + envelope, decrypt.
    const inftAddress = this.chain.cfg.addresses.ZeroArenaINFT;
    const provider = new JsonRpcProvider(this.chain.cfg.rpc);
    const inft = new Contract(inftAddress, ZERO_ARENA_INFT_ABI, provider);
    const oldStorageRoot = (await inft.storageRoots!(input.tokenId)) as string;
    const oldEnvelope = await this.storage.downloadBytes(oldStorageRoot);
    const plaintext = decrypt(oldEnvelope, kOld);

    // 3-4. Re-encrypt with a fresh key; upload.
    const kNew = generateKey();
    const newEnvelope = encrypt(plaintext, kNew);
    const newMetadataHash = keccak256(newEnvelope);
    await this.storage.uploadBytes(newEnvelope);

    // 5. Wrap K_new under the recipient's pubkey.
    const sealedKey = wrapKey(kNew, input.recipientPubKey);
    const sealedKeyHash = keccak256(sealedKey);

    // 6. Sign the proof tuple.
    const network = await provider.getNetwork();
    const chainId = network.chainId;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + (this.cfg.deadlineSec ?? PROOF_TTL_SECONDS));
    const digest = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'address', 'uint256', 'address', 'address', 'bytes32', 'bytes32', 'uint256'],
        [
          chainId,
          inftAddress,
          input.tokenId,
          input.from,
          input.to,
          sealedKeyHash,
          newMetadataHash,
          deadline,
        ],
      ),
    );
    const signature = await this.oracle.signMessage(getBytes(digest));

    const proof = AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256', 'bytes'],
      [newMetadataHash, deadline, signature],
    );

    // 7. Submit.
    const result = await this.chain.submitTransfer({
      from: input.from,
      to: input.to,
      tokenId: input.tokenId,
      sealedKey,
      proof: getBytes(proof),
    });
    // The chain adapter returns ZERO_BYTES32 if it can't find the
    // MetadataUpdated event (which happens when newMetadataHash was already
    // current — never our case, but be defensive).
    if (result.newMetadataHash === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      return { ...result, newMetadataHash };
    }
    return result;
  }
}

/** Helper: derive the uncompressed secp256k1 pubkey from a private key hex. */
export function pubKeyFromPrivate(privateKey: string): string {
  // ethers' SigningKey gives us the uncompressed key directly.
  return new Wallet(privateKey).signingKey.publicKey;
}

/** Helper: write hexed sealed key to a file (for offline distribution / demos). */
export function sealedKeyToHex(sealed: Uint8Array): string {
  return hexlify(sealed);
}
