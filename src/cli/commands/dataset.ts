import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { ZeroArena } from '../../ZeroArena.js';
import { ingestFromBinance } from '../../dataset/ingest.js';
import type { Market } from '../../types.js';
import { configFromEnv, loadEnv } from '../env.js';

export const datasetCommand = new Command('dataset').description('Fetch / upload / download OHLCV datasets');

datasetCommand
  .command('upload <csvPath>')
  .description('Upload a canonical CSV to 0G Storage and print its rootHash')
  .action(async (csvPath: string) => {
    loadEnv();
    const za = new ZeroArena(configFromEnv());
    const ds = await za.uploadDataset(resolve(csvPath));
    process.stdout.write(
      JSON.stringify(
        {
          rootHash: ds.rootHash,
          datasetHash: ds.datasetHash,
          candles: ds.candles.length,
          meta: ds.meta,
        },
        null,
        2,
      ) + '\n',
    );
  });

datasetCommand
  .command('load <rootHash>')
  .description('Download a dataset by storage rootHash')
  .requiredOption('--out <path>', 'output file path')
  .action(async (rootHash: string, opts: { out: string }) => {
    loadEnv();
    const za = new ZeroArena(configFromEnv());
    const ds = await za.loadDataset({ rootHash });
    const outPath = resolve(opts.out);
    await mkdir(dirname(outPath), { recursive: true });
    // Re-emit canonical CSV from the parsed candles + meta. Round-trip safe.
    const { StorageAdapter } = await import('../../storage/StorageAdapter.js');
    await StorageAdapter.writeCanonicalCsv(outPath, ds.meta, ds.candles);
    process.stdout.write(`wrote ${ds.candles.length} candles to ${outPath}\n`);
    process.stdout.write(`datasetHash=${ds.datasetHash}\n`);
  });

// Binance fetch → canonical CSV. Optionally upload to 0G Storage in one shot.
datasetCommand
  .command('ingest')
  .description('Fetch Binance klines, merge into a canonical CSV, optionally upload')
  .requiredOption('-s, --symbol <symbol>', 'Binance symbol (e.g. BTCUSDT)')
  .requiredOption('-i, --interval <interval>', 'kline interval (e.g. 15m, 1h)')
  .requiredOption('--from <date>', 'start date YYYY-MM-DD (inclusive)')
  .option('--to <date>', 'end date YYYY-MM-DD (default: now)')
  .option('-m, --market <market>', 'spot | perp', 'spot')
  .option('-o, --out <path>', 'CSV output path', './data.csv')
  .option('--upload', 'after writing, upload to 0G Storage', false)
  .action(async (opts: { symbol: string; interval: string; from: string; to?: string; market: string; out: string; upload?: boolean }) => {
    const market: Market = opts.market === 'perp' ? 'perp' : 'spot';
    const startTs = parseDate(opts.from);
    const endTs = opts.to ? parseDate(opts.to) : undefined;
    const csvPath = resolve(opts.out);

    const result = await ingestFromBinance({
      symbol: opts.symbol.toUpperCase(),
      interval: opts.interval,
      market,
      startTs,
      ...(endTs !== undefined ? { endTs } : {}),
      csvPath,
      onPage: (page, total) => process.stderr.write(`page ${page} → ${total} candles\n`),
    });
    process.stderr.write(`✓ ${result.candleCount} candles (fetched ${result.fetchedCount}) → ${csvPath}\n`);
    process.stderr.write(`  datasetHash=${result.datasetHash}\n`);

    if (opts.upload) {
      loadEnv();
      const za = new ZeroArena(configFromEnv());
      process.stderr.write(`▸ uploading to 0G Storage…\n`);
      const ds = await za.uploadDataset(csvPath);
      process.stdout.write(JSON.stringify({
        rootHash: ds.rootHash, datasetHash: ds.datasetHash, candles: result.candleCount, meta: result.meta,
      }, null, 2) + '\n');
    } else {
      process.stdout.write(JSON.stringify({
        datasetHash: result.datasetHash, candles: result.candleCount, meta: result.meta, csvPath,
      }, null, 2) + '\n');
    }
  });

function parseDate(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  }
  throw new Error(`--from / --to must be YYYY-MM-DD or ms epoch (got "${s}")`);
}

// Local-only convenience: parse a CSV without uploading. Useful for offline
// backtests against fixture data.
datasetCommand
  .command('parse <csvPath>')
  .description('Parse a local CSV and print its datasetHash without uploading')
  .action(async (csvPath: string) => {
    const { StorageAdapter } = await import('../../storage/StorageAdapter.js');
    const ds = await StorageAdapter.parseDatasetFile(resolve(csvPath));
    process.stdout.write(
      JSON.stringify(
        {
          rootHash: ds.rootHash,
          datasetHash: ds.datasetHash,
          candles: ds.candles.length,
          meta: ds.meta,
        },
        null,
        2,
      ) + '\n',
    );
  });
