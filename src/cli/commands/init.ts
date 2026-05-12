import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Command } from 'commander';
import { computeAddress, Wallet } from 'ethers';

const GALILEO = {
  rpc: 'https://evmrpc-testnet.0g.ai',
  indexer: 'https://indexer-storage-testnet-turbo.0g.ai',
  cert: '0x21a5DEA59cfA07B261d389A9554477e137805c2f',
  inft: '0x4Bd4d45f206861aa7cD4421785a316A1dD06036f',
  oracle: '0x63909dA30b0d65ad72b32b3C8C82515f7BFA6Fd6',
};

export const initCommand = new Command('init')
  .description('Scaffold a new Zero Arena agent project')
  .argument('[name]', 'project directory name')
  .option('-t, --template <template>', 'template (rsi-spot)', 'rsi-spot')
  .option('--key <hex>', 'use this PRIVATE_KEY (skip prompt)')
  .option('--no-install', 'skip `npm install`')
  .action(async (nameArg: string | undefined, opts: InitOpts) => {
    if (opts.template !== 'rsi-spot') {
      throw new Error(`unknown template "${opts.template}". v0.1 ships: rsi-spot`);
    }

    const rl = createInterface({ input, output });
    try {
      const name = nameArg ?? (await rl.question('Project name: ')).trim();
      if (!name) throw new Error('project name required');

      const dir = resolve(process.cwd(), name);
      if (existsSync(dir)) throw new Error(`directory already exists: ${dir}`);

      const privateKey = opts.key ?? (await promptKey(rl));
      if (privateKey && !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
        throw new Error('private key must be 0x-prefixed 32-byte hex');
      }

      mkdirSync(dir, { recursive: true });
      for (const [path, content] of files(name, privateKey)) {
        writeFileSync(resolve(dir, path), content);
      }

      const shouldInstall =
        opts.install !== false &&
        (await rl.question('Run `npm install` now? (Y/n) ')).trim().toLowerCase() !== 'n';
      rl.close();

      if (shouldInstall) {
        process.stdout.write('\n▸ installing…\n');
        execSync('npm install', { cwd: dir, stdio: 'inherit' });
      }

      const addr = privateKey ? computeAddress(privateKey) : null;
      process.stdout.write(`\n✓ created ${name}/\n`);
      if (addr) process.stdout.write(`  wallet:  ${addr}\n  faucet:  https://faucet.0g.ai\n`);
      else process.stdout.write(`  ⚠ no PRIVATE_KEY set — edit .env before running\n`);
      process.stdout.write(`\nNext:\n  cd ${name}\n  npm start\n`);
    } finally {
      rl.close();
    }
  });

interface InitOpts {
  template: string;
  key?: string;
  install?: boolean;
}

async function promptKey(rl: ReturnType<typeof createInterface>): Promise<string | undefined> {
  const hasCast = (() => {
    try {
      execSync('cast --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  process.stdout.write('\nWallet setup:\n');
  process.stdout.write('  1) Paste your own PRIVATE_KEY\n');
  if (hasCast) process.stdout.write('  2) Generate a fresh wallet via `cast wallet new`\n');
  process.stdout.write(`  ${hasCast ? '3' : '2'}) Skip — fill .env later\n`);

  const choice = (await rl.question(`Choose [1-${hasCast ? '3' : '2'}]: `)).trim();

  if (choice === '1') {
    const key = (await rl.question('PRIVATE_KEY (0x…): ')).trim();
    return key;
  }
  if (choice === '2' && hasCast) {
    const raw = execSync('cast wallet new', { encoding: 'utf8' });
    const m = /Private key:\s*(0x[0-9a-fA-F]{64})/.exec(raw);
    if (!m) throw new Error('cast wallet new: could not parse output');
    const key = m[1]!;
    process.stdout.write(`  → ${computeAddress(key)}\n  fund at https://faucet.0g.ai\n`);
    return key;
  }
  return undefined;
}

function files(name: string, privateKey: string | undefined): Array<[string, string]> {
  const keyLine = privateKey ?? '0x';
  return [
    ['package.json', pkg(name)],
    ['tsconfig.json', tsconfig()],
    ['.gitignore', gitignore()],
    ['.env', envFile(keyLine)],
    ['.env.example', envFile('0x')],
    ['agent.ts', agentTs()],
    ['run.ts', runTs()],
    ['README.md', readme(name)],
  ];
}

function pkg(name: string): string {
  return (
    JSON.stringify(
      {
        name,
        version: '0.0.1',
        private: true,
        type: 'module',
        scripts: {
          start: 'tsx run.ts',
          backtest: 'tsx run.ts --backtest-only',
        },
        dependencies: {
          zeroarena: '^0.1.1',
        },
        devDependencies: {
          tsx: '^4.7.0',
          typescript: '^5.5.0',
        },
      },
      null,
      2,
    ) + '\n'
  );
}

function tsconfig(): string {
  return (
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      },
      null,
      2,
    ) + '\n'
  );
}

function gitignore(): string {
  return ['node_modules/', '.env', '*.log', '.zeroarena/', '*.key', ''].join('\n');
}

function envFile(keyLine: string): string {
  return [
    `ZA_RPC=${GALILEO.rpc}`,
    `ZA_INDEXER=${GALILEO.indexer}`,
    '',
    '# Your wallet. Signs certify + mintAgent, pays gas, owns the iNFT.',
    `PRIVATE_KEY=${keyLine}`,
    '',
    `ZA_ADDR_CERT=${GALILEO.cert}`,
    `ZA_ADDR_INFT=${GALILEO.inft}`,
    `ZA_ADDR_ORACLE=${GALILEO.oracle}`,
    '',
  ].join('\n');
}

function agentTs(): string {
  return `import { Agent, type Action, type Observation } from 'zeroarena';

export class RsiAgent extends Agent {
  constructor(
    public readonly oversold = 30,
    public readonly overbought = 70,
    public readonly sizeFraction = 0.5,
  ) {
    super();
  }

  override decide(obs: Observation): Action {
    if (obs.rsi14 < this.oversold) return { direction: 1, size: this.sizeFraction };
    if (obs.rsi14 > this.overbought) return { direction: 0, size: 0 };
    return { direction: obs.position > 0 ? 1 : 0, size: obs.position > 0 ? this.sizeFraction : 0 };
  }

  override toJSON(): Record<string, unknown> {
    return {
      className: 'RsiAgent',
      oversold: this.oversold,
      overbought: this.overbought,
      sizeFraction: this.sizeFraction,
    };
  }
}

export default RsiAgent;
`;
}

function runTs(): string {
  return `import { ZeroArena, CANONICAL_DATASETS, configFromEnv, loadEnv, type BacktestOptions } from 'zeroarena';
import RsiAgent from './agent.js';

// Pass --backtest-only to skip the chain calls (certify + mint). Useful for
// first-run smoke checks before you fund the wallet in .env.
const BACKTEST_ONLY = process.argv.includes('--backtest-only');

const OPTS: BacktestOptions = {
  initialBalance: 10_000,
  market: 'spot',
  feeBps: 10,
  slippageBps: 5,
};

async function main() {
  loadEnv();
  const za = new ZeroArena(configFromEnv());

  const { rootHash } = CANONICAL_DATASETS['BTCUSDT-15m-spot']!;
  console.log(\`▸ loading dataset from 0G Storage…\`);
  const dataset = await za.loadDataset({ rootHash });
  console.log(\`  \${dataset.candles.length} candles\`);

  const agent = new RsiAgent();
  const result = await za.backtest(agent, dataset, OPTS);
  console.log(\`\\n▸ backtest\\n  runHash: \${result.runHash}\\n  return:  \${result.metrics.totalReturnBps} bps\\n  sharpe:  \${result.metrics.sharpeX1000 / 1000}\`);

  if (BACKTEST_ONLY) {
    console.log(\`\\n✓ backtest-only complete. Run \\\`npm start\\\` to certify + mint on 0G Chain.\`);
    return;
  }

  console.log(\`\\n▸ certifying on 0G Chain…\`);
  const cert = await za.certify(result);
  console.log(\`  certId: \${cert.certId}\\n  tx:     https://chainscan-galileo.0g.ai/tx/\${cert.txHash}\`);

  console.log(\`\\n▸ minting iNFT…\`);
  const inft = await za.mintAgent({ agent, certificate: cert, name: 'My RSI Agent v1' });
  console.log(\`  tokenId: \${inft.tokenId}\\n  tx:      https://chainscan-galileo.0g.ai/tx/\${inft.txHash}\`);

  console.log(\`\\n✓ done. Trust tier: T2.\`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
`;
}

function readme(name: string): string {
  return `# ${name}

Zero Arena starter — RSI mean-reversion agent on BTC/USDT 15m spot.

## Run

\`\`\`bash
npm install        # if you skipped it during init
npm start          # backtest → certify → mint
\`\`\`

You'll see a \`runHash\`, a \`certId\` on \`AgentCertificate\`, and a \`tokenId\` on \`ZeroArenaINFT\`. Every value is linkable on <https://chainscan-galileo.0g.ai>.

## Edit

- \`agent.ts\` — your strategy. Anything in \`toJSON()\` becomes part of \`agentHash\`.
- \`run.ts\` — the pipeline. Backtest options, dataset selection, mint name.

Determinism rules: no \`Math.random()\`, no \`Date.now()\`, no \`for…in\` on objects. Same agent + same dataset → same \`runHash\`.

## Trust tier

Certificates are minted at **T2** — commitment on-chain + owner-authorized reproducibility. T3 (TEE attestation via 0G Compute) ships in v0.2 with no code change.

The AES key for your encrypted run log is written to \`~/.zeroarena/keys/agent-<tokenId>.key\` — **keep it** so future verifiers can decrypt.
`;
}
