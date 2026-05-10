import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import type { Agent } from '../../agent/Agent.js';
import { runBacktest } from '../../backtest/BacktestEngine.js';
import { StorageAdapter } from '../../storage/StorageAdapter.js';
import type { BacktestOptions, Market } from '../../types.js';
import { configFromEnv, loadEnv } from '../env.js';
import { ZeroArena } from '../../ZeroArena.js';

export const backtestCommand = new Command('backtest')
  .description('Run a deterministic backtest against a CSV or 0G-anchored dataset')
  .option('--agent <path>', 'path to a JS/TS module whose default export is an Agent subclass')
  .option('--csv <path>', 'local CSV file (no upload)')
  .option('--root <hash>', 'load dataset from 0G Storage by rootHash (requires .env)')
  .option('--balance <num>', 'initial balance in quote currency', '10000')
  .option('--market <m>', 'spot | perp', 'spot')
  .option('--leverage <num>', 'perp leverage (capped at 10)', '1')
  .option('--fee-bps <num>', 'taker fee in basis points', '10')
  .option('--slippage-bps <num>', 'slippage in basis points', '5')
  .option('--out <path>', 'write result JSON to this path')
  .action(async (opts: BacktestCliOpts) => {
    if (!opts.agent) throw new Error('--agent <path> is required');
    if (!opts.csv && !opts.root) throw new Error('one of --csv or --root is required');

    const Agent = await loadAgent(opts.agent);
    const dataset = opts.csv
      ? await StorageAdapter.parseDatasetFile(resolve(opts.csv))
      : await loadFromChain(opts.root!);

    const market = opts.market as Market;
    const backtestOpts: BacktestOptions = {
      initialBalance: Number(opts.balance),
      market,
      leverage: market === 'perp' ? Number(opts.leverage) : 1,
      feeBps: Number(opts.feeBps),
      slippageBps: Number(opts.slippageBps),
    };
    const result = await runBacktest(Agent, dataset, backtestOpts);

    process.stdout.write(
      JSON.stringify(
        {
          runHash: result.runHash,
          metrics: result.metrics,
          trades: result.trades.length,
          finalEquity: result.metrics.finalEquity,
        },
        null,
        2,
      ) + '\n',
    );

    if (opts.out) {
      const outPath = resolve(opts.out);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, JSON.stringify(result, replacer, 2));
      process.stdout.write(`wrote full result to ${outPath}\n`);
    }
  });

interface BacktestCliOpts {
  agent?: string;
  csv?: string;
  root?: string;
  balance: string;
  market: string;
  leverage: string;
  feeBps: string;
  slippageBps: string;
  out?: string;
}

async function loadAgent(path: string): Promise<Agent> {
  const url = pathToFileURL(resolve(path)).href;
  const mod = (await import(url)) as { default?: unknown; Agent?: unknown };
  const ctor = (mod.default ?? mod.Agent) as new () => Agent;
  if (typeof ctor !== 'function') {
    throw new Error(`Agent module at ${path} must default-export an Agent subclass`);
  }
  return new ctor();
}

async function loadFromChain(rootHash: string) {
  loadEnv();
  const za = new ZeroArena(configFromEnv());
  return za.loadDataset({ rootHash });
}

function replacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}
