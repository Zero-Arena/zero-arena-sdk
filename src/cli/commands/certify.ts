import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import type { Agent } from '../../agent/Agent.js';
import { runBacktest } from '../../backtest/BacktestEngine.js';
import { StorageAdapter } from '../../storage/StorageAdapter.js';
import type { BacktestOptions, BacktestResult, Market, TrustTier } from '../../types.js';
import { configFromEnv, loadEnv } from '../env.js';
import { ZeroArena } from '../../ZeroArena.js';

export const certifyCommand = new Command('certify')
  .description('Encrypt + upload the run log, then anchor a Certificate on 0G Chain')
  .option('--agent <path>', 'agent module (re-runs the backtest end-to-end)')
  .option('--csv <path>', 'local CSV (used with --agent)')
  .option('--root <hash>', '0G Storage rootHash (used with --agent)')
  .option('--balance <num>', 'initial balance', '10000')
  .option('--market <m>', 'spot | perp', 'spot')
  .option('--leverage <num>', 'perp leverage', '1')
  .option('--fee-bps <num>', 'fee in bps', '10')
  .option('--slippage-bps <num>', 'slippage in bps', '5')
  .option('--result <path>', 'OR: certify a previously-saved result JSON')
  .option('--tier <T1|T2>', 'trust tier (v0.1 supports T1 + T2)', 'T2')
  .action(async (opts: CertifyCliOpts) => {
    loadEnv();
    const za = new ZeroArena(configFromEnv());

    let result: BacktestResult;
    if (opts.result) {
      const text = await readFile(resolve(opts.result), 'utf8');
      result = JSON.parse(text) as BacktestResult;
    } else {
      if (!opts.agent || (!opts.csv && !opts.root)) {
        throw new Error(
          'pass either --result <path> OR (--agent <path> AND one of --csv/--root)',
        );
      }
      const Agent = await loadAgent(opts.agent);
      const dataset = opts.csv
        ? await StorageAdapter.parseDatasetFile(resolve(opts.csv))
        : await za.loadDataset({ rootHash: opts.root! });
      const market = opts.market as Market;
      const bo: BacktestOptions = {
        initialBalance: Number(opts.balance),
        market,
        leverage: market === 'perp' ? Number(opts.leverage) : 1,
        feeBps: Number(opts.feeBps),
        slippageBps: Number(opts.slippageBps),
      };
      result = await runBacktest(Agent, dataset, bo);
    }

    const cert = await za.certify(result, { trustTier: opts.tier as TrustTier });
    process.stdout.write(
      JSON.stringify(
        {
          certId: cert.certId.toString(),
          runHash: cert.runHash,
          storageRootHash: cert.storageRootHash,
          trustTier: cert.trustTier,
          market: cert.market,
          metrics: cert.metrics,
          txHash: cert.txHash,
        },
        null,
        2,
      ) + '\n',
    );
  });

interface CertifyCliOpts {
  agent?: string;
  csv?: string;
  root?: string;
  balance: string;
  market: string;
  leverage: string;
  feeBps: string;
  slippageBps: string;
  result?: string;
  tier: string;
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
