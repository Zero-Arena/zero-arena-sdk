// One-shot Binance → canonical CSV pipeline. Merges with an existing CSV if
// `csvPath` already exists. Returns the written datasetHash so callers can
// upload to 0G Storage.

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Candle, DatasetMeta, Market } from '../types.js';
import { StorageAdapter } from '../storage/StorageAdapter.js';
import { fetchKlines } from './binance.js';

export interface IngestKlinesOptions {
  symbol: string;
  interval: string;
  market: Market;
  startTs: number;
  endTs?: number;          // defaults to now floored to interval boundary
  csvPath: string;
  onPage?: (page: number, total: number) => void;
}

export interface IngestResult {
  csvPath: string;
  datasetHash: string;
  candleCount: number;
  fetchedCount: number;
  startTs: number;
  endTs: number;
  meta: DatasetMeta;
}

const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000,
  '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000,
};

export async function ingestFromBinance(opts: IngestKlinesOptions): Promise<IngestResult> {
  const step = INTERVAL_MS[opts.interval];
  if (!step) throw new Error(`ingestFromBinance: unsupported interval "${opts.interval}"`);
  const cutoff = opts.endTs ?? floorTo(Date.now(), step);

  await mkdir(dirname(opts.csvPath), { recursive: true });
  const prior = existsSync(opts.csvPath)
    ? (await StorageAdapter.parseDatasetFile(opts.csvPath)).candles
    : [];
  const resumeFrom = prior.length > 0 ? (prior[prior.length - 1]!.timestamp + step) : opts.startTs;

  const fresh = resumeFrom < cutoff
    ? await fetchKlines({ symbol: opts.symbol, interval: opts.interval, startTs: resumeFrom, endTs: cutoff, ...(opts.onPage ? { onPage: opts.onPage } : {}) })
    : [];

  const merged = mergeCandles(prior, fresh);
  if (merged.length === 0) {
    throw new Error('ingestFromBinance: no candles available (prior + fresh both empty)');
  }

  const meta: DatasetMeta = {
    asset: opts.symbol.replace(/USDT$/, ''),
    quote: 'USDT',
    market: opts.market,
    granularity: opts.interval,
    source: 'binance',
    startTs: merged[0]!.timestamp,
    endTs: merged[merged.length - 1]!.timestamp,
  };
  const { datasetHash } = await StorageAdapter.writeCanonicalCsv(opts.csvPath, meta, merged);

  return {
    csvPath: opts.csvPath,
    datasetHash,
    candleCount: merged.length,
    fetchedCount: fresh.length,
    startTs: meta.startTs,
    endTs: meta.endTs,
    meta,
  };
}

export function mergeCandles(prior: readonly Candle[], fresh: readonly Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of prior) m.set(c.timestamp, c);
  for (const c of fresh) m.set(c.timestamp, c);
  return [...m.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function floorTo(ts: number, step: number): number {
  return Math.floor(ts / step) * step;
}
