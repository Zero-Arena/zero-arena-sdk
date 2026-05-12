// Minimal ECIES wrapper used to seal an AES-256 key under a recipient's
// secp256k1 public key. The format is:
//
//   sealedKey = ephemeralPubKey(65) || iv(12) || ciphertext(32) || tag(16)
//
// On the recipient side, derive the shared secret via ECDH(recipientPriv,
// ephemeralPub), HKDF it to a 32-byte AES key, then AES-256-GCM-decrypt the
// 32-byte payload. This is the v0.1 stub — production swaps this for the
// 0G Compute TEE-attested re-encryption flow (see CLAUDE.md 3, 14).

import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';

const SEALED_LEN = 65 + 12 + 32 + 16;

/** Wrap a 32-byte symmetric key under a recipient's secp256k1 public key. */
export function wrapKey(symmetricKey: Uint8Array, recipientPubKey: string): Buffer {
  if (symmetricKey.length !== 32) throw new Error('wrapKey: payload must be 32 bytes');
  const recipientPub = parsePubKey(recipientPubKey);

  const ecdh = createECDH('secp256k1');
  ecdh.generateKeys();
  const ephemeralPub = ecdh.getPublicKey(null, 'uncompressed'); // 65 bytes, leading 0x04
  const shared = ecdh.computeSecret(recipientPub);
  const aesKey = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('ZA-iNFT-v1'), 32));

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const ct = Buffer.concat([cipher.update(symmetricKey), cipher.final()]);
  const tag = cipher.getAuthTag();

  const out = Buffer.concat([ephemeralPub, iv, ct, tag]);
  if (out.length !== SEALED_LEN) {
    throw new Error(`wrapKey: unexpected sealed length ${out.length}, expected ${SEALED_LEN}`);
  }
  return out;
}

/** Inverse of `wrapKey`. The recipient supplies their secp256k1 private key. */
export function unwrapKey(sealed: Uint8Array, recipientPrivKey: string): Buffer {
  if (sealed.length !== SEALED_LEN) {
    throw new Error(`unwrapKey: expected ${SEALED_LEN} bytes, got ${sealed.length}`);
  }
  const buf = Buffer.from(sealed);
  const ephemeralPub = buf.subarray(0, 65);
  const iv = buf.subarray(65, 77);
  const ct = buf.subarray(77, 109);
  const tag = buf.subarray(109, 125);

  const priv = parsePrivKey(recipientPrivKey);
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(priv);
  const shared = ecdh.computeSecret(ephemeralPub);
  const aesKey = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('ZA-iNFT-v1'), 32));

  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function parsePubKey(hex: string): Buffer {
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (stripped.length === 130) return Buffer.from(stripped, 'hex'); // 65-byte uncompressed
  if (stripped.length === 128) return Buffer.from('04' + stripped, 'hex'); // missing 0x04 prefix
  throw new Error(
    `parsePubKey: expected 65-byte uncompressed secp256k1 (0x04…) hex, got ${stripped.length / 2} bytes`,
  );
}

function parsePrivKey(hex: string): Buffer {
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (stripped.length !== 64) throw new Error('parsePrivKey: expected 32-byte hex');
  return Buffer.from(stripped, 'hex');
}
