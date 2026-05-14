import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Command } from 'commander';
import { computeAddress } from 'ethers';
import {
  customAgent,
  emaAgent,
  envFile,
  gitignore,
  llmAnthropic,
  llmClaudeCode,
  llmGemini,
  llmOpenAI,
  macdAgent,
  pkgJson,
  readme,
  rsiAgent,
  runTs,
  tsconfigJson,
  type Generated,
  type LlmProvider,
  type Market,
} from './init-templates.js';

const GALILEO = {
  rpc: 'https://evmrpc-testnet.0g.ai',
  indexer: 'https://indexer-storage-testnet-turbo.0g.ai',
  cert: '0x77f29d2a7BcAC679812d9a0FB1c7508eDA6B087e',
  inft: '0xF7162ecbdB11DE4704043D4aF93B4030AD61700e',
  oracle: '0x733667CEBB27e310a8fb60799Af73A8C1fe501b2',
};

type StrategyKey = 'rsi' | 'macd' | 'ema' | 'llm' | 'custom';

const STRATEGIES: Array<{ key: StrategyKey; label: string; defaultMarket: Market; agentName: string }> = [
  { key: 'rsi',    label: 'RSI mean reversion',        defaultMarket: 'spot', agentName: 'RsiAgent' },
  { key: 'macd',   label: 'MACD trend follower',       defaultMarket: 'spot', agentName: 'MacdAgent' },
  { key: 'ema',    label: 'EMA(12/26) crossover',      defaultMarket: 'spot', agentName: 'EmaCrossoverAgent' },
  { key: 'llm',    label: 'LLM-driven (any provider)', defaultMarket: 'spot', agentName: 'LlmAgent' },
  { key: 'custom', label: 'Custom — empty scaffold',   defaultMarket: 'spot', agentName: 'CustomAgent' },
];

const LLM_PROVIDERS: Array<{ key: LlmProvider; label: string; defaultModel: string }> = [
  { key: 'anthropic',   label: 'Anthropic Claude (API key)',      defaultModel: 'claude-sonnet-4-6' },
  { key: 'openai',      label: 'OpenAI GPT (API key)',            defaultModel: 'gpt-4o-mini' },
  { key: 'gemini',      label: 'Google Gemini (API key)',         defaultModel: 'gemini-2.0-flash' },
  { key: 'claude-code', label: 'Local Claude Code CLI (no key)',  defaultModel: '' },
];

export const initCommand = new Command('init')
  .description('Scaffold a new Zero Arena agent project (interactive wizard)')
  .argument('[name]', 'project directory name')
  .option('--key <hex>', 'use this PRIVATE_KEY (skip prompt)')
  .option('--no-install', 'skip `npm install`')
  .action(async (nameArg: string | undefined, opts: InitOpts) => {
    const rl = createInterface({ input, output, terminal: !!process.stdin.isTTY });
    try {
      printBanner();

      const name = nameArg ?? (await ask(rl, 'Project name', 'my-agent'));
      if (!name) throw new Error('project name required');

      const dir = resolve(process.cwd(), name);
      if (existsSync(dir)) throw new Error(`directory already exists: ${dir}`);

      const strategy = await pickStrategy(rl);
      const market = await pickMarket(rl, strategy.defaultMarket);
      const perpParams = market === 'perp' ? await askPerpParams(rl) : { leverage: 1 };

      const generated = await runStrategyWizard(rl, strategy.key);

      const privateKey = opts.key ?? (await promptKey(rl));
      if (privateKey && !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
        throw new Error('private key must be 0x-prefixed 32-byte hex');
      }

      mkdirSync(dir, { recursive: true });
      const mintName = await ask(rl, 'iNFT name (shown on mint)', `${strategy.label} v1`);

      for (const [path, content] of buildFiles({
        name,
        privateKey,
        strategy: strategy.key,
        agentName: strategy.agentName,
        market,
        leverage: perpParams.leverage,
        generated,
        mintName,
      })) {
        writeFileSync(resolve(dir, path), content);
      }

      const shouldInstall =
        opts.install !== false &&
        (await ask(rl, 'Run `npm install` now? (Y/n)', 'Y')).toLowerCase() !== 'n';
      rl.close();

      if (shouldInstall) {
        process.stdout.write('\n▸ installing…\n');
        execSync('npm install', { cwd: dir, stdio: 'inherit' });
      }

      printSummary({ name, strategy: strategy.label, market, generated, privateKey, shouldInstall });
    } finally {
      rl.close();
    }
  });

interface InitOpts {
  key?: string;
  install?: boolean;
}

// ─── wizard helpers ───────────────────────────────────────────────────────

function printBanner(): void {
  process.stdout.write('\nZero Arena — agent scaffold\n');
  process.stdout.write('────────────────────────────\n\n');
}

async function ask(rl: ReturnType<typeof createInterface>, prompt: string, fallback?: string): Promise<string> {
  const tail = fallback !== undefined ? ` (${fallback})` : '';
  const answer = (await rl.question(`? ${prompt}${tail}: `)).trim();
  return answer === '' && fallback !== undefined ? fallback : answer;
}

async function pickFromMenu<T>(
  rl: ReturnType<typeof createInterface>,
  title: string,
  choices: Array<{ label: string }>,
  defaultIndex = 0,
): Promise<number> {
  process.stdout.write(`\n${title}\n`);
  for (let i = 0; i < choices.length; i++) {
    process.stdout.write(`  ${i + 1}) ${choices[i]!.label}\n`);
  }
  const raw = (await rl.question(`Choose [1-${choices.length}] (${defaultIndex + 1}): `)).trim();
  const n = raw === '' ? defaultIndex + 1 : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > choices.length) {
    throw new Error(`invalid choice "${raw}"`);
  }
  return n - 1;
}

async function pickStrategy(rl: ReturnType<typeof createInterface>): Promise<(typeof STRATEGIES)[number]> {
  const idx = await pickFromMenu(rl, 'Strategy template:', STRATEGIES);
  return STRATEGIES[idx]!;
}

async function pickMarket(rl: ReturnType<typeof createInterface>, defaultMarket: Market): Promise<Market> {
  const idx = await pickFromMenu(
    rl,
    'Market:',
    [{ label: 'Spot (long-only, no leverage)' }, { label: 'Perpetual futures (leverage, funding, liquidation)' }],
    defaultMarket === 'spot' ? 0 : 1,
  );
  return idx === 0 ? 'spot' : 'perp';
}

async function askPerpParams(rl: ReturnType<typeof createInterface>): Promise<{ leverage: number }> {
  const leverage = clamp(Number(await ask(rl, 'Leverage (1-10)', '3')), 1, 10);
  return { leverage };
}

async function runStrategyWizard(
  rl: ReturnType<typeof createInterface>,
  key: StrategyKey,
): Promise<Generated> {
  if (key === 'rsi') {
    const oversold = clamp(Number(await ask(rl, 'RSI oversold threshold', '30')), 1, 99);
    const overbought = clamp(Number(await ask(rl, 'RSI overbought threshold', '70')), 1, 99);
    const sizeFraction = clamp(Number(await ask(rl, 'Position size as fraction of equity', '0.5')), 0.01, 1);
    return rsiAgent({ oversold, overbought, sizeFraction });
  }
  if (key === 'macd') {
    const sizeFraction = clamp(Number(await ask(rl, 'Position size as fraction of equity', '0.5')), 0.01, 1);
    return macdAgent({ sizeFraction });
  }
  if (key === 'ema') {
    const sizeFraction = clamp(Number(await ask(rl, 'Position size as fraction of equity', '0.5')), 0.01, 1);
    return emaAgent({ sizeFraction });
  }
  if (key === 'custom') {
    return customAgent();
  }
  // llm
  const provIdx = await pickFromMenu(rl, 'LLM provider:', LLM_PROVIDERS);
  const provider = LLM_PROVIDERS[provIdx]!;
  const sizeFraction = clamp(Number(await ask(rl, 'Position size as fraction of equity', '0.5')), 0.01, 1);
  if (provider.key === 'claude-code') {
    return llmClaudeCode({ sizeFraction });
  }
  const model = await ask(rl, 'Model name', provider.defaultModel);
  if (provider.key === 'anthropic') return llmAnthropic({ model, sizeFraction });
  if (provider.key === 'openai') return llmOpenAI({ model, sizeFraction });
  return llmGemini({ model, sizeFraction });
}

async function promptKey(rl: ReturnType<typeof createInterface>): Promise<string | undefined> {
  const hasCast = (() => {
    try { execSync('cast --version', { stdio: 'ignore' }); return true; }
    catch { return false; }
  })();

  const choices = [
    { label: 'Paste your own PRIVATE_KEY' },
    ...(hasCast ? [{ label: 'Generate a fresh wallet via `cast wallet new`' }] : []),
    { label: 'Skip — fill .env later' },
  ];
  const idx = await pickFromMenu(rl, 'Wallet setup:', choices, 0);

  if (idx === 0) {
    const key = (await rl.question('PRIVATE_KEY (0x…): ')).trim();
    return key || undefined;
  }
  if (hasCast && idx === 1) {
    const raw = execSync('cast wallet new', { encoding: 'utf8' });
    const m = /Private key:\s*(0x[0-9a-fA-F]{64})/.exec(raw);
    if (!m) throw new Error('cast wallet new: could not parse output');
    const key = m[1]!;
    process.stdout.write(`  → ${computeAddress(key)}\n  fund at https://faucet.0g.ai\n`);
    return key;
  }
  return undefined;
}

// ─── file generation ──────────────────────────────────────────────────────

function buildFiles(p: {
  name: string;
  privateKey: string | undefined;
  strategy: StrategyKey;
  agentName: string;
  market: Market;
  leverage: number;
  generated: Generated;
  mintName: string;
}): Array<[string, string]> {
  const keyLine = p.privateKey ?? '0x';
  const env = envFile({ keyLine, galileo: GALILEO, extraEnv: p.generated.extraEnv });
  const envExample = envFile({ keyLine: '0x', galileo: GALILEO, extraEnv: p.generated.extraEnv });
  return [
    ['package.json', pkgJson(p.name, p.generated.extraDeps)],
    ['tsconfig.json', tsconfigJson()],
    ['.gitignore', gitignore()],
    ['.env', env],
    ['.env.example', envExample],
    ['agent.ts', p.generated.agentSource],
    ['run.ts', runTs({
      market: p.market,
      initialBalance: 10_000,
      leverage: p.leverage,
      takerFeeBps: 10,
      slippageBps: 5,
      agentName: p.agentName,
      mintName: p.mintName,
    })],
    ['README.md', readme(p.name, p.generated.readmeNote)],
  ];
}

function printSummary(s: {
  name: string;
  strategy: string;
  market: Market;
  generated: Generated;
  privateKey: string | undefined;
  shouldInstall: boolean;
}): void {
  const addr = s.privateKey ? computeAddress(s.privateKey) : null;
  process.stdout.write(`\n✓ created ${s.name}/\n`);
  process.stdout.write(`  strategy: ${s.strategy} on ${s.market}\n`);
  if (addr) process.stdout.write(`  wallet:   ${addr}\n  faucet:   https://faucet.0g.ai\n`);
  else process.stdout.write(`  ⚠ no PRIVATE_KEY set — edit .env before running\n`);
  if (s.generated.extraEnv.some((l) => l.endsWith('_API_KEY='))) {
    process.stdout.write(`  ⚠ set the *_API_KEY value in .env, or the agent falls back to a deterministic heuristic\n`);
  }
  process.stdout.write(`\nNext:\n  cd ${s.name}\n  ${s.shouldInstall ? '' : 'npm install\n  '}npm run backtest   # offline\n  npm start          # full pipeline (needs PRIVATE_KEY + Galileo gas)\n`);
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) throw new Error(`expected a number, got "${n}"`);
  return Math.min(Math.max(n, lo), hi);
}
