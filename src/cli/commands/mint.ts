import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import type { Agent } from '../../agent/Agent.js';
import { ZeroArena } from '../../ZeroArena.js';
import type { Certificate, Market, TrustTier } from '../../types.js';
import { configFromEnv, loadEnv } from '../env.js';

export const mintCommand = new Command('mint')
  .description('Mint a passing certificate as an ERC-7857 iNFT')
  .requiredOption('--agent <path>', 'agent module (default-exports an Agent subclass)')
  .requiredOption('--cert <id>', 'certificate id from a prior `certify`')
  .requiredOption('--name <name>', 'public name for the iNFT')
  .option('--description <text>', 'public description', '')
  .option('--run-hash <0x..>', 'runHash from the certify step (hex)')
  .option('--storage-root <0x..>', 'encrypted run-log storage root (hex)')
  .option('--dataset-hash <0x..>', 'datasetHash committed by the certify step (hex)')
  .option('--market <m>', 'spot | perp', 'spot')
  .option('--tier <T1|T2|T3>', 'trust tier the certificate was minted under', 'T2')
  .action(async (opts: MintCliOpts) => {
    loadEnv();
    const za = new ZeroArena(configFromEnv());

    const Agent = await loadAgent(opts.agent);
    const certificate: Certificate = {
      certId: BigInt(opts.cert),
      runHash: opts.runHash ?? requireHex('--run-hash'),
      storageRootHash: opts.storageRoot ?? requireHex('--storage-root'),
      datasetHash: opts.datasetHash ?? requireHex('--dataset-hash'),
      attestationHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      trustTier: opts.tier as TrustTier,
      market: opts.market as Market,
      // The mint flow doesn't depend on metrics — it only needs identity hashes
      // — so we pass through zeros. The on-chain threshold check uses the
      // certId, which the contract dereferences itself.
      metrics: {
        totalReturnBps: 0, sharpeX1000: 0, sortinoX1000: 0, maxDrawdownBps: 0,
        profitFactorX1000: 0, winRateBps: 0, numTrades: 0, finalEquity: 0,
      },
      txHash: '0x',
    };

    const inft = await za.mintAgent({
      agent: Agent,
      certificate,
      name: opts.name,
      description: opts.description,
    });

    process.stdout.write(
      JSON.stringify(
        {
          tokenId: inft.tokenId.toString(),
          owner: inft.owner,
          certificateId: inft.certificateId.toString(),
          metadataHash: inft.metadataHash,
          storageRoot: inft.storageRoot,
          txHash: inft.txHash,
        },
        null,
        2,
      ) + '\n',
    );
  });

interface MintCliOpts {
  agent: string;
  cert: string;
  name: string;
  description: string;
  runHash?: string;
  storageRoot?: string;
  datasetHash?: string;
  market: string;
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

function requireHex(flag: string): string {
  throw new Error(`mint requires ${flag}. Pass it explicitly or wire it from the certify output.`);
}
