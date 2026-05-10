// Canonical hashing for the verification protocol. Same inputs → same `runHash`,
// always — this is the cryptographic identity at the heart of T1 and T2.
//
// `runHash = keccak256(agentHash || datasetHash || optionsHash || tradesHash)`
//
// Each component hashes a stable JSON serialization (keys sorted, no whitespace,
// numbers in canonical decimal form). Object iteration order is the #1 source of
// non-determinism; never trust `JSON.stringify` for these inputs.

import { keccak256, toUtf8Bytes, getBytes, concat, hexlify } from 'ethers';
import type { Agent } from '../agent/Agent.js';
import type { BacktestOptions, Trade } from '../types.js';

/**
 * Stable JSON: sorted keys at every level, no whitespace, numbers via
 * `Number.prototype.toString()` (which gives canonical decimal). Throws on
 * unsupported value types — fail loud rather than silently produce drift.
 */
export function stableStringify(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error(`stableStringify: non-finite number ${v}`);
    }
    return v.toString();
  }
  if (typeof v === 'bigint') return `"${v.toString()}n"`;
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) {
    return '[' + v.map(serialize).join(',') + ']';
  }
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i] as string;
      parts[i] = JSON.stringify(k) + ':' + serialize(obj[k]);
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`stableStringify: unsupported value type ${typeof v}`);
}

export function hashJson(value: unknown): string {
  return keccak256(toUtf8Bytes(stableStringify(value)));
}

export function hashAgent(agent: Agent): string {
  return hashJson(agent.toJSON());
}

/**
 * Hash the user-facing options. We deliberately omit `initialBalance` from
 * `agentHash`-style identity (it lives on the cert) — but we DO include it here
 * because the trade list is a function of the starting capital.
 */
export function hashOptions(opts: BacktestOptions): string {
  return hashJson({
    initialBalance: opts.initialBalance,
    market: opts.market,
    leverage: opts.leverage ?? 1,
    feeBps: opts.feeBps ?? 10,
    slippageBps: opts.slippageBps ?? 5,
    liquidationMarginBps: opts.liquidationMarginBps ?? 500,
  });
}

export function hashTrades(trades: readonly Trade[]): string {
  // Project to a canonical shape — never depend on field-insertion order.
  const canon = trades.map((t) => ({
    fee: t.fee,
    index: t.index,
    price: t.price,
    reason: t.reason,
    side: t.side,
    size: t.size,
    timestamp: t.timestamp,
  }));
  return hashJson(canon);
}

/**
 * Compose the four component hashes into the canonical `runHash`.
 *
 * All four inputs MUST be 0x-prefixed bytes32 hex strings.
 */
export function composeRunHash(
  agentHash: string,
  datasetHash: string,
  optionsHash: string,
  tradesHash: string,
): string {
  const buf = concat([getBytes(agentHash), getBytes(datasetHash), getBytes(optionsHash), getBytes(tradesHash)]);
  return keccak256(hexlify(buf));
}
