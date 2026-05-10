import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { ZeroArena } from '../../ZeroArena.js';
import { configFromEnv, loadEnv } from '../env.js';

export const datasetCommand = new Command('dataset').description('Upload / download OHLCV datasets');

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
