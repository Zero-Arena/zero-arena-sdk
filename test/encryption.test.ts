import { describe, expect, it } from 'vitest';
import {
  CIPHER_AES_256_GCM,
  ENVELOPE_MAGIC,
  ENVELOPE_VERSION,
  decrypt,
  encrypt,
  generateKey,
  keyFromHex,
  keyToHex,
} from '../src/storage/encryption.js';

describe('encryption envelope', () => {
  it('round-trips arbitrary bytes', () => {
    const key = generateKey();
    const msg = Buffer.from('zero arena run log: { trades: [...], hash: 0xabc }', 'utf8');
    const env = encrypt(msg, key);
    const out = decrypt(env, key);
    expect(out.equals(msg)).toBe(true);
  });

  it('writes the documented header bytes', () => {
    const env = encrypt(Buffer.from('x'), generateKey());
    expect(env[0]).toBe(ENVELOPE_MAGIC);
    expect(env[1]).toBe(ENVELOPE_VERSION);
    expect(env[2]).toBe(CIPHER_AES_256_GCM);
  });

  it('produces a different IV on every call', () => {
    const key = generateKey();
    const a = encrypt(Buffer.from('same plaintext'), key);
    const b = encrypt(Buffer.from('same plaintext'), key);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('rejects a tampered ciphertext', () => {
    const key = generateKey();
    const env = encrypt(Buffer.from('honest'), key);
    env[env.length - 1] ^= 0x01;
    expect(() => decrypt(env, key)).toThrow();
  });

  it('rejects a wrong key', () => {
    const env = encrypt(Buffer.from('hello'), generateKey());
    expect(() => decrypt(env, generateKey())).toThrow();
  });

  it('rejects non-32-byte keys', () => {
    expect(() => encrypt(Buffer.from('x'), Buffer.alloc(16))).toThrow();
    expect(() => decrypt(Buffer.alloc(40), Buffer.alloc(16))).toThrow();
  });

  it('rejects a bad magic byte', () => {
    const key = generateKey();
    const env = encrypt(Buffer.from('hi'), key);
    env[0] = 0x00;
    expect(() => decrypt(env, key)).toThrow(/magic/);
  });

  it('keyToHex / keyFromHex round-trip', () => {
    const k = generateKey();
    const hex = keyToHex(k);
    expect(hex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(keyFromHex(hex).equals(k)).toBe(true);
  });
});
