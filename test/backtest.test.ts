// The mandatory determinism test from CLAUDE.md 7. The whole verification
// protocol depends on `runHash` being byte-identical across repeated runs of
// the same (agent, dataset, options) tuple.

import { describe, it, expect } from 'vitest';
import { Agent } from '../src/agent/Agent.js';
import { resolveBarsPerYear, runBacktest } from '../src/backtest/BacktestEngine.js';
import type { Action, BacktestOptions, Candle, Dataset, Observation } from '../src/types.js';
import { keccak256, toUtf8Bytes } from 'ethers';

class RsiAgent extends Agent {
  decide(obs: Observation): Action {
    if (obs.rsi14 < 30) return { direction: 1, size: 0.2 };
    if (obs.rsi14 > 70) return { direction: -1, size: 0.2 };
    return { direction: 0, size: 0 };
  }
}

class FlipAgent extends Agent {
  decide(obs: Observation): Action {
    return obs.macd > obs.macdSignal
      ? { direction: 1, size: 0.5 }
      : { direction: -1, size: 0.5 };
  }
}

function makeSineDataset(market: 'spot' | 'perp', n = 500): Dataset {
  const candles: Candle[] = new Array(n);
  for (let i = 0; i < n; i++) {
    // Deterministic sinusoidal price series with a small drift.
    const base = 100 + Math.sin(i / 17) * 8 + Math.cos(i / 31) * 4 + i * 0.02;
    const open = base;
    const close = base + Math.sin(i / 11) * 0.5;
    const high = Math.max(open, close) + 0.3;
    const low = Math.min(open, close) - 0.3;
    candles[i] = {
      timestamp: 1_700_000_000_000 + i * 3_600_000,
      open,
      high,
      low,
      close,
      volume: 1000 + (i % 50),
      ...(market === 'perp' && i % 8 === 0 ? { fundingRate: 0.0001 } : {}),
    };
  }
  // Synthetic dataset hash — what the ingestion script would compute over the
  // canonical CSV bytes. For tests, derive it from the candle list.
  const datasetHash = keccak256(toUtf8Bytes(JSON.stringify(candles)));
  return {
    rootHash: '0x' + '00'.repeat(32),
    datasetHash,
    candles,
    meta: {
      asset: 'BTC',
      quote: 'USDT',
      market,
      granularity: '1h',
      source: 'synthetic',
      startTs: candles[0]!.timestamp,
      endTs: candles[n - 1]!.timestamp,
    },
  };
}

describe('BacktestEngine — determinism (CLAUDE.md 7 critical test)', () => {
  it('produces the same runHash 10 times in a row (spot, RSI agent)', async () => {
    const dataset = makeSineDataset('spot');
    const opts: BacktestOptions = { initialBalance: 10_000, market: 'spot' };

    const hashes = new Set<string>();
    let firstResult;
    for (let i = 0; i < 10; i++) {
      const r = await runBacktest(new RsiAgent(), dataset, opts);
      hashes.add(r.runHash);
      if (i === 0) firstResult = r;
    }
    expect(hashes.size).toBe(1);
    expect(firstResult?.runHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('produces the same runHash 10 times in a row (perp, MACD flip agent)', async () => {
    const dataset = makeSineDataset('perp');
    const opts: BacktestOptions = {
      initialBalance: 10_000, market: 'perp', leverage: 3,
    };

    const hashes = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const r = await runBacktest(new FlipAgent(), dataset, opts);
      hashes.add(r.runHash);
    }
    expect(hashes.size).toBe(1);
  });

  it('runHash differs when the agent class differs', async () => {
    const dataset = makeSineDataset('spot');
    const opts: BacktestOptions = { initialBalance: 10_000, market: 'spot' };
    const a = await runBacktest(new RsiAgent(), dataset, opts);
    const b = await runBacktest(new FlipAgent(), dataset, opts);
    expect(a.runHash).not.toBe(b.runHash);
    expect(a.agentHash).not.toBe(b.agentHash);
  });

  it('runHash differs when initialBalance differs', async () => {
    const dataset = makeSineDataset('spot');
    const a = await runBacktest(new RsiAgent(), dataset, { initialBalance: 10_000, market: 'spot' });
    const b = await runBacktest(new RsiAgent(), dataset, { initialBalance: 20_000, market: 'spot' });
    expect(a.runHash).not.toBe(b.runHash);
    expect(a.optionsHash).not.toBe(b.optionsHash);
  });

  it('rejects a market mismatch between options and dataset', async () => {
    const spotDataset = makeSineDataset('spot');
    await expect(
      runBacktest(new RsiAgent(), spotDataset, { initialBalance: 10_000, market: 'perp' }),
    ).rejects.toThrow(/market/);
  });

  it('emits an equity curve the length of the dataset', async () => {
    const dataset = makeSineDataset('spot', 200);
    const r = await runBacktest(new RsiAgent(), dataset, { initialBalance: 10_000, market: 'spot' });
    expect(r.equityCurve.length).toBe(200);
  });
});

describe('BacktestEngine — output sanity', () => {
  it('computes finite metrics on a non-trivial run', async () => {
    const dataset = makeSineDataset('spot', 400);
    const r = await runBacktest(new RsiAgent(), dataset, { initialBalance: 10_000, market: 'spot' });
    expect(Number.isFinite(r.metrics.totalReturnBps)).toBe(true);
    expect(Number.isFinite(r.metrics.sharpeX1000)).toBe(true);
    expect(r.metrics.maxDrawdownBps).toBeGreaterThanOrEqual(0);
    expect(r.metrics.winRateBps).toBeGreaterThanOrEqual(0);
    expect(r.metrics.numTrades).toBe(r.trades.length);
  });
});

describe('resolveBarsPerYear', () => {
  it('returns the canonical bars-per-year for every supported granularity', () => {
    expect(resolveBarsPerYear('1m')).toBe(525_600);
    expect(resolveBarsPerYear('5m')).toBe(105_120);
    expect(resolveBarsPerYear('15m')).toBe(35_040);
    expect(resolveBarsPerYear('30m')).toBe(17_520);
    expect(resolveBarsPerYear('1h')).toBe(8_760);
    expect(resolveBarsPerYear('4h')).toBe(2_190);
    expect(resolveBarsPerYear('1d')).toBe(365);
  });

  it('throws on an unknown granularity (fail-loud per FORMULAS.md 7)', () => {
    expect(() => resolveBarsPerYear('17m')).toThrow(/unsupported granularity/);
    expect(() => resolveBarsPerYear('')).toThrow(/unsupported granularity/);
  });
});

describe('BacktestEngine — granularity-aware Sharpe annualization', () => {
  // Same equity curve, two granularity tags → Sharpe scales by sqrt(ratio).
  // 15m has 4× more bars/year than 1h, so Sharpe(15m) / Sharpe(1h) ≈ √4 = 2.
  it('scales Sharpe by sqrt(barsPerYear ratio) when granularity changes', async () => {
    const base = makeSineDataset('spot', 400);
    const dataset15m: Dataset = { ...base, meta: { ...base.meta, granularity: '15m' } };
    const dataset1h: Dataset = { ...base, meta: { ...base.meta, granularity: '1h' } };

    const opts: BacktestOptions = { initialBalance: 10_000, market: 'spot' };
    const r15 = await runBacktest(new RsiAgent(), dataset15m, opts);
    const r1h = await runBacktest(new RsiAgent(), dataset1h, opts);

    // Trades + equity identical (same candles + same agent).
    expect(r15.tradesHash).toBe(r1h.tradesHash);
    expect(r15.metrics.totalReturnBps).toBe(r1h.metrics.totalReturnBps);

    // Sharpe should differ ONLY in the annualization factor.
    if (r1h.metrics.sharpeX1000 !== 0) {
      const ratio = r15.metrics.sharpeX1000 / r1h.metrics.sharpeX1000;
      const expected = Math.sqrt(35_040 / 8_760); // = 2
      // Allow 1% drift for integer rounding (sharpeX1000 is rounded).
      expect(Math.abs(ratio - expected)).toBeLessThan(0.01);
    }
  });

  it('rejects a dataset whose meta.granularity is not supported', async () => {
    const bad = makeSineDataset('spot');
    const broken: Dataset = { ...bad, meta: { ...bad.meta, granularity: '17m' } };
    await expect(
      runBacktest(new RsiAgent(), broken, { initialBalance: 10_000, market: 'spot' }),
    ).rejects.toThrow(/unsupported granularity/);
  });

  it('runHash is invariant across granularity meta (commitment is over trades + dataset bytes)', async () => {
    // runHash = keccak(agentHash || datasetHash || optionsHash || tradesHash).
    // None of those depend on `meta.granularity` directly — datasetHash is
    // already keccak256(CSV bytes), and the CSV embeds its meta in the header.
    // So two Dataset objects with the same candles but different in-memory meta
    // produce the same runHash (and the metrics differ, which is why this bug
    // was silent on-chain pre-fix).
    const base = makeSineDataset('spot', 200);
    const dataset15m: Dataset = { ...base, meta: { ...base.meta, granularity: '15m' } };
    const dataset1h: Dataset = { ...base, meta: { ...base.meta, granularity: '1h' } };
    const opts: BacktestOptions = { initialBalance: 10_000, market: 'spot' };

    const r15 = await runBacktest(new RsiAgent(), dataset15m, opts);
    const r1h = await runBacktest(new RsiAgent(), dataset1h, opts);

    expect(r15.runHash).toBe(r1h.runHash);
  });
});
