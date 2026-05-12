#!/usr/bin/env node

// `zeroarena` CLI entrypoint. Composed of four sub-commands:
//   - dataset {upload, load, parse}
//   - backtest
//   - certify
//   - mint
//
// All shared config (RPC, indexer, contract addresses, signer key) is read
// from the environment: PRIVATE_KEY, ZA_RPC, ZA_INDEXER, ZA_ADDR_CERT,
// ZA_ADDR_INFT, ZA_ADDR_ORACLE.

import { createRequire } from 'node:module';
import { Command } from 'commander';
import { backtestCommand } from './commands/backtest.js';
import { certifyCommand } from './commands/certify.js';
import { datasetCommand } from './commands/dataset.js';
import { initCommand } from './commands/init.js';
import { mintCommand } from './commands/mint.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

const program = new Command();
program
  .name('zeroarena')
  .description('Verifiable AI trading agents on 0G — backtest, certify, mint')
  .version(version);

program.addCommand(initCommand);
program.addCommand(datasetCommand);
program.addCommand(backtestCommand);
program.addCommand(certifyCommand);
program.addCommand(mintCommand);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
