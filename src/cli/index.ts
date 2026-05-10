#!/usr/bin/env node

// `zeroarena` CLI entrypoint. Composed of four sub-commands:
//   - dataset {upload, load, parse}
//   - backtest
//   - certify
//   - mint
//
// All shared config (RPC, indexer, contract addresses, signer key) is read
// from the environment — see sdk/.env.example for the full list.

import { Command } from 'commander';
import { backtestCommand } from './commands/backtest.js';
import { certifyCommand } from './commands/certify.js';
import { datasetCommand } from './commands/dataset.js';
import { mintCommand } from './commands/mint.js';

const program = new Command();
program
  .name('zeroarena')
  .description('Verifiable AI trading agents on 0G — backtest, certify, mint')
  .version('0.0.0');

program.addCommand(datasetCommand);
program.addCommand(backtestCommand);
program.addCommand(certifyCommand);
program.addCommand(mintCommand);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
