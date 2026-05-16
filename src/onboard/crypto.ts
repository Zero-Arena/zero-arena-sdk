// ECIES encryption helper for the onboard endpoint. Mirrors
// zero-arena-be/src/onboard/crypto.ts on the encryption side: an owner
// encrypts their agent source against the operator's secp256k1 pubkey
// (fetched from /health), and the operator decrypts in-memory only.
//
// Uses eciesjs (ECIES over secp256k1 + AES-256-GCM) with no extra
// configuration — both sides must agree on the SCHEME constant below.

import * as ecies from 'eciesjs';

export const SCHEME_V1 = 'ecies-secp256k1-aes256gcm-v1' as const;

export interface EncryptedAgentBundle {
  scheme: typeof SCHEME_V1;
  /** Base64-encoded ECIES blob produced by `eciesjs.encrypt(operatorPubKey, plaintext)`. */
  blob: string;
}

/**
 * Encrypt a plaintext agent source against the operator's compressed
 * secp256k1 pubkey (33-byte hex). Returns a wire-ready bundle.
 */
export function encryptAgentSource(
  plaintext: string,
  operatorPubKeyHex: string,
): EncryptedAgentBundle {
  if (!plaintext || plaintext.length === 0) {
    throw new Error('encryptAgentSource: plaintext is empty');
  }
  const pkHex = operatorPubKeyHex.replace(/^0x/, '');
  if (pkHex.length !== 66 && pkHex.length !== 130) {
    throw new Error(
      `encryptAgentSource: operatorPubKey must be 33 bytes (compressed) or 65 bytes (uncompressed) hex; got ${pkHex.length / 2} bytes`,
    );
  }
  const ciphertext = ecies.encrypt(pkHex, new TextEncoder().encode(plaintext));
  const buf = Buffer.from(ciphertext);
  return {
    scheme: SCHEME_V1,
    blob: buf.toString('base64'),
  };
}
