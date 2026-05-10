import { Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import { generateKey } from '../src/storage/encryption.js';
import { unwrapKey, wrapKey } from '../src/inft/ecies.js';
import { pubKeyFromPrivate } from '../src/inft/TransferAdapter.js';

describe('ECIES sealedKey wrap', () => {
  it('round-trips a 32-byte AES key', () => {
    const recipient = Wallet.createRandom();
    const pub = pubKeyFromPrivate(recipient.privateKey);

    const k = generateKey();
    const sealed = wrapKey(k, pub);
    const out = unwrapKey(sealed, recipient.privateKey);

    expect(out.equals(k)).toBe(true);
    expect(sealed.length).toBe(65 + 12 + 32 + 16);
  });

  it('produces a different sealed key on every call (fresh ephemeral)', () => {
    const recipient = Wallet.createRandom();
    const pub = pubKeyFromPrivate(recipient.privateKey);
    const k = generateKey();

    const a = wrapKey(k, pub);
    const b = wrapKey(k, pub);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('rejects unwrap with the wrong recipient key', () => {
    const recipient = Wallet.createRandom();
    const wrong = Wallet.createRandom();
    const pub = pubKeyFromPrivate(recipient.privateKey);

    const sealed = wrapKey(generateKey(), pub);
    expect(() => unwrapKey(sealed, wrong.privateKey)).toThrow();
  });

  it('rejects a tampered sealed key', () => {
    const recipient = Wallet.createRandom();
    const pub = pubKeyFromPrivate(recipient.privateKey);
    const sealed = wrapKey(generateKey(), pub);
    sealed[sealed.length - 1] ^= 0x01;
    expect(() => unwrapKey(sealed, recipient.privateKey)).toThrow();
  });

  it('accepts a recipient pubkey without the 0x04 prefix', () => {
    const recipient = Wallet.createRandom();
    const fullPub = pubKeyFromPrivate(recipient.privateKey); // 0x04…
    const trimmed = '0x' + fullPub.slice(4); // strip the 0x04 marker

    const k = generateKey();
    const sealed = wrapKey(k, trimmed);
    expect(unwrapKey(sealed, recipient.privateKey).equals(k)).toBe(true);
  });
});
