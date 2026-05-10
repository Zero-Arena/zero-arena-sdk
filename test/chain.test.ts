// Offline smoke tests for ChainAdapter — verifies the embedded ABI fragments
// parse and expose the methods/events the SDK calls. Live RPC tests are
// covered by the example flows on Galileo testnet.

import { Interface } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  AGENT_CERTIFICATE_ABI,
  REENCRYPTION_ORACLE_ABI,
  ZERO_ARENA_INFT_ABI,
  marketFromByte,
  marketToByte,
  trustTierToByte,
} from '../src/chain/abi.js';

describe('ChainAdapter ABI smoke', () => {
  it('AgentCertificate ABI parses and has submit + get + event', () => {
    const iface = new Interface(AGENT_CERTIFICATE_ABI as unknown as string[]);
    expect(iface.getFunction('submit')).toBeTruthy();
    expect(iface.getFunction('get')).toBeTruthy();
    expect(iface.getEvent('CertificateSubmitted')).toBeTruthy();
  });

  it('ZeroArenaINFT ABI parses and has mint + transfer + clone + events', () => {
    const iface = new Interface(ZERO_ARENA_INFT_ABI as unknown as string[]);
    expect(iface.getFunction('mint')).toBeTruthy();
    expect(iface.getFunction('transfer')).toBeTruthy();
    expect(iface.getFunction('clone')).toBeTruthy();
    expect(iface.getFunction('authorizeUsage')).toBeTruthy();
    expect(iface.getEvent('AgentMinted')).toBeTruthy();
    expect(iface.getEvent('MetadataUpdated')).toBeTruthy();
    expect(iface.getEvent('SealedKeyDelivered')).toBeTruthy();
  });

  it('ReencryptionOracle ABI parses and has signer + verifyTransfer', () => {
    const iface = new Interface(REENCRYPTION_ORACLE_ABI as unknown as string[]);
    expect(iface.getFunction('signer')).toBeTruthy();
    expect(iface.getFunction('verifyTransfer')).toBeTruthy();
  });

  it('trust tier and market byte encoders round-trip', () => {
    expect(trustTierToByte('T1')).toBe(1);
    expect(trustTierToByte('T2')).toBe(2);
    expect(trustTierToByte('T3')).toBe(3);
    expect(marketToByte('spot')).toBe(0);
    expect(marketToByte('perp')).toBe(1);
    expect(marketFromByte(0)).toBe('spot');
    expect(marketFromByte(1)).toBe('perp');
  });
});
