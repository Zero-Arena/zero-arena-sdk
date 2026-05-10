// Offline tests for StorageAdapter — covers the dataset CSV canonicalization
// and parse path. Live 0G upload/download is exercised by examples + manual
// integration runs (no testnet credentials in CI).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StorageAdapter } from '../src/storage/StorageAdapter.js';
import type { Candle, DatasetMeta } from '../src/types.js';

const META: DatasetMeta = {
  asset: 'BTC',
  quote: 'USDT',
  market: 'spot',
  granularity: '1h',
  source: 'binance',
  startTs: 1_700_000_000_000,
  endTs: 1_700_010_800_000,
};

function fakeCandles(n: number): Candle[] {
  const out: Candle[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = 100 + i * 0.5;
    out[i] = {
      timestamp: 1_700_000_000_000 + i * 3_600_000,
      open: p,
      high: p + 1,
      low: p - 1,
      close: p + 0.25,
      volume: 1000 + i,
    };
  }
  return out;
}

describe('StorageAdapter dataset round-trip (offline)', () => {
  it('writeCanonicalCsv → parseDatasetFile preserves data and hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-storage-test-'));
    try {
      const path = join(dir, 'btc-spot-1h.csv');
      const candles = fakeCandles(40);
      const { datasetHash } = await StorageAdapter.writeCanonicalCsv(path, META, candles);
      const ds = await StorageAdapter.parseDatasetFile(path);

      expect(ds.datasetHash).toBe(datasetHash);
      expect(ds.rootHash).toBe(`local:${datasetHash}`);
      expect(ds.meta).toEqual(META);
      expect(ds.candles.length).toBe(candles.length);
      expect(ds.candles[0]?.timestamp).toBe(candles[0]?.timestamp);
      expect(ds.candles[0]?.close).toBeCloseTo(candles[0]?.close ?? 0, 10);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('round-trips perp candles with fundingRate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-storage-test-'));
    try {
      const path = join(dir, 'btc-perp-1h.csv');
      const candles = fakeCandles(10).map((c, i) => ({
        ...c,
        fundingRate: i % 8 === 0 ? 0.0001 : 0,
      }));
      const meta = { ...META, market: 'perp' as const };
      await StorageAdapter.writeCanonicalCsv(path, meta, candles);
      const ds = await StorageAdapter.parseDatasetFile(path);
      expect(ds.meta.market).toBe('perp');
      expect(ds.candles[0]?.fundingRate).toBeCloseTo(0.0001);
      expect(ds.candles[1]?.fundingRate).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a CSV without meta when no fallback is supplied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-storage-test-'));
    try {
      const path = join(dir, 'no-meta.csv');
      // Write a CSV with only a header + rows, no meta line.
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, 'timestamp,open,high,low,close,volume\n1,2,3,4,5,6\n');
      await expect(StorageAdapter.parseDatasetFile(path)).rejects.toThrow(/meta/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('produces a stable datasetHash for identical inputs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-storage-test-'));
    try {
      const a = join(dir, 'a.csv');
      const b = join(dir, 'b.csv');
      const candles = fakeCandles(5);
      const ra = await StorageAdapter.writeCanonicalCsv(a, META, candles);
      const rb = await StorageAdapter.writeCanonicalCsv(b, META, candles);
      expect(ra.datasetHash).toBe(rb.datasetHash);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
