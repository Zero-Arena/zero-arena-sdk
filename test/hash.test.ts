import { describe, it, expect } from 'vitest';
import {
  composeRunHash,
  hashAgent,
  hashJson,
  hashOptions,
  hashTrades,
  stableStringify,
} from '../src/backtest/hash.js';
import { Agent } from '../src/agent/Agent.js';
import type { Action, BacktestOptions, Observation, Trade } from '../src/types.js';

class StubAgent extends Agent {
  decide(_obs: Observation): Action {
    return { direction: 0, size: 0 };
  }
}

describe('stableStringify', () => {
  it('produces the same bytes regardless of key insertion order', () => {
    const a = stableStringify({ b: 1, a: 2, c: { y: 3, x: 4 } });
    const b = stableStringify({ c: { x: 4, y: 3 }, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('round-trips primitive types deterministically', () => {
    expect(stableStringify(1)).toBe('1');
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify(true)).toBe('true');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify([3, 2, 1])).toBe('[3,2,1]');
  });

  it('throws on non-finite numbers', () => {
    expect(() => stableStringify(NaN)).toThrow();
    expect(() => stableStringify(Infinity)).toThrow();
  });

  it('throws on undefined and functions', () => {
    expect(() => stableStringify(undefined)).toThrow();
    expect(() => stableStringify(() => 0)).toThrow();
  });
});

describe('hashAgent', () => {
  it('hashes the className by default — same class, same hash', () => {
    expect(hashAgent(new StubAgent())).toBe(hashAgent(new StubAgent()));
  });

  it('changes when toJSON exposes hyperparameters', () => {
    class Tuned extends Agent {
      constructor(private k: number) { super(); }
      decide(): Action { return { direction: 0, size: 0 }; }
      override toJSON() { return { className: 'Tuned', k: this.k }; }
    }
    expect(hashAgent(new Tuned(1))).not.toBe(hashAgent(new Tuned(2)));
  });
});

describe('hashOptions', () => {
  it('is stable across equivalent option objects', () => {
    const o1: BacktestOptions = { initialBalance: 10_000, market: 'spot', feeBps: 10 };
    const o2: BacktestOptions = { feeBps: 10, market: 'spot', initialBalance: 10_000 };
    expect(hashOptions(o1)).toBe(hashOptions(o2));
  });

  it('treats omitted fields as their documented defaults', () => {
    const minimal: BacktestOptions = { initialBalance: 10_000, market: 'spot' };
    const explicit: BacktestOptions = {
      initialBalance: 10_000, market: 'spot',
      leverage: 1, feeBps: 10, slippageBps: 5, liquidationMarginBps: 500,
    };
    expect(hashOptions(minimal)).toBe(hashOptions(explicit));
  });

  it('changes when a field changes', () => {
    const a: BacktestOptions = { initialBalance: 10_000, market: 'spot' };
    const b: BacktestOptions = { initialBalance: 10_001, market: 'spot' };
    expect(hashOptions(a)).not.toBe(hashOptions(b));
  });
});

describe('hashTrades', () => {
  it('is independent of trade-object property iteration order', () => {
    const t1: Trade = { index: 0, timestamp: 0, side: 'buy', price: 1, size: 1, fee: 0, reason: 'open', realizedPnl: 0 };
    const t2 = { reason: 'open', realizedPnl: 0, size: 1, price: 1, side: 'buy', timestamp: 0, fee: 0, index: 0 } as Trade;
    expect(hashTrades([t1])).toBe(hashTrades([t2]));
  });

  it('is sensitive to trade order', () => {
    const t1: Trade = { index: 0, timestamp: 0, side: 'buy', price: 1, size: 1, fee: 0, reason: 'open', realizedPnl: 0 };
    const t2: Trade = { index: 1, timestamp: 0, side: 'sell', price: 2, size: 1, fee: 0, reason: 'close', realizedPnl: 0 };
    expect(hashTrades([t1, t2])).not.toBe(hashTrades([t2, t1]));
  });
});

describe('composeRunHash', () => {
  it('produces a 32-byte hex string', () => {
    const h = composeRunHash(
      hashJson('a'), hashJson('b'), hashJson('c'), hashJson('d'),
    );
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('changes when any component changes', () => {
    const base = composeRunHash(hashJson('a'), hashJson('b'), hashJson('c'), hashJson('d'));
    expect(
      composeRunHash(hashJson('a'), hashJson('b'), hashJson('c'), hashJson('e')),
    ).not.toBe(base);
    expect(
      composeRunHash(hashJson('a'), hashJson('x'), hashJson('c'), hashJson('d')),
    ).not.toBe(base);
  });
});
