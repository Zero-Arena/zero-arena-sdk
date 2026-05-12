// OracleClient — the SDK-side abstraction over the ERC-7857 re-encryption
// oracle. The SDK NEVER holds the oracle's private key. Implementations
// decide where/how the key is held; from the SDK's perspective an oracle
// is simply "something that can sign a transfer proof when asked."
//
// Two shipped implementations:
//   - `HttpOracleClient`  — POSTs to a remote oracle service. The production
//     path. The oracle service holds the key in isolation.
//   - `LocalOracleClient` — convenience for operators who run the oracle in
//     the same process (e.g., demo / dev). Explicit at the call site so it
//     is obvious when this trusted-mode shortcut is being used.
//
// The runtime contract (digest the oracle must sign) is co-located in
// `oracleDigest()` so both client and server agree byte-for-byte.

import { AbiCoder, keccak256 } from 'ethers';

/**
 * Inputs to the proof signature. Mirrors the tuple `ZeroArenaINFT.transfer`
 * verifies on-chain (see `ZeroArenaINFT.sol`).
 */
export interface TransferProofRequest {
  chainId: bigint;
  inftAddress: string;
  tokenId: bigint;
  from: string;
  to: string;
  /** keccak256 of the sealed (recipient-wrapped) AES key. */
  sealedKeyHash: string;
  /** keccak256 of the freshly re-encrypted envelope on 0G Storage. */
  newMetadataHash: string;
  /** Seconds since epoch. The on-chain verifier rejects after this. */
  deadline: bigint;
}

export interface OracleClient {
  /**
   * Sign the ERC-7857 re-encryption proof and return the raw EIP-191
   * signature bytes (`0x...`). The SDK wraps the result into the ABI-
   * encoded proof the contract expects.
   */
  signTransferProof(req: TransferProofRequest): Promise<string>;
}

/**
 * Canonical digest the oracle is asked to sign. Single source of truth —
 * both `LocalOracleClient` and the off-process oracle service compute it
 * the same way.
 */
export function oracleDigest(req: TransferProofRequest): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'address', 'uint256', 'address', 'address', 'bytes32', 'bytes32', 'uint256'],
      [
        req.chainId,
        req.inftAddress,
        req.tokenId,
        req.from,
        req.to,
        req.sealedKeyHash,
        req.newMetadataHash,
        req.deadline,
      ],
    ),
  );
}
