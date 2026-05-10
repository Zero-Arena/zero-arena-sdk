// AES-256-GCM authenticated encryption for run logs and agent metadata.
// Pure Node crypto — zero external dependencies. The output format is a
// canonical, version-tagged byte layout so artifacts uploaded today can still
// be decrypted by a future SDK that may add additional cipher modes.
//
// Layout (binary):
//   [0]      magic byte 0x5A          ('Z' for ZeroArena)
//   [1]      version byte 0x01        (current envelope version)
//   [2]      cipher id   0x01         (AES-256-GCM, 12-byte IV, 16-byte tag)
//   [3..14]  iv (12 bytes)
//   [15..30] auth tag (16 bytes)
//   [31..]   ciphertext (variable)

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const ENVELOPE_MAGIC = 0x5a;
export const ENVELOPE_VERSION = 0x01;
export const CIPHER_AES_256_GCM = 0x01;
const HEADER_LEN = 3 + 12 + 16; // magic + version + cipher + iv + tag

/** Generate a fresh 32-byte AES-256 key. */
export function generateKey(): Buffer {
  return randomBytes(32);
}

/** Encrypt `plaintext` under `key`. The IV is freshly random per call. */
export function encrypt(plaintext: Uint8Array, key: Uint8Array): Buffer {
  if (key.length !== 32) throw new Error('encrypt: key must be 32 bytes (AES-256)');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const out = Buffer.alloc(HEADER_LEN + ciphertext.length);
  out[0] = ENVELOPE_MAGIC;
  out[1] = ENVELOPE_VERSION;
  out[2] = CIPHER_AES_256_GCM;
  iv.copy(out, 3);
  tag.copy(out, 15);
  ciphertext.copy(out, HEADER_LEN);
  return out;
}

/** Decrypt an envelope produced by `encrypt`. Throws on tamper / wrong key. */
export function decrypt(envelope: Uint8Array, key: Uint8Array): Buffer {
  if (key.length !== 32) throw new Error('decrypt: key must be 32 bytes (AES-256)');
  if (envelope.length < HEADER_LEN) throw new Error('decrypt: envelope too short');
  if (envelope[0] !== ENVELOPE_MAGIC) throw new Error('decrypt: bad magic byte');
  if (envelope[1] !== ENVELOPE_VERSION) {
    throw new Error(`decrypt: unsupported envelope version ${envelope[1]}`);
  }
  if (envelope[2] !== CIPHER_AES_256_GCM) {
    throw new Error(`decrypt: unsupported cipher id ${envelope[2]}`);
  }
  const buf = Buffer.from(envelope);
  const iv = buf.subarray(3, 15);
  const tag = buf.subarray(15, 31);
  const ciphertext = buf.subarray(HEADER_LEN);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Hex-encode a key for safe logging / .env round-tripping. */
export function keyToHex(key: Uint8Array): string {
  return '0x' + Buffer.from(key).toString('hex');
}

/** Inverse of `keyToHex`. Tolerates 0x prefix. */
export function keyFromHex(hex: string): Buffer {
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (stripped.length !== 64) throw new Error('keyFromHex: expected 32-byte hex');
  return Buffer.from(stripped, 'hex');
}
