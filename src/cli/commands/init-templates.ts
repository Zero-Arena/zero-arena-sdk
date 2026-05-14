// Template strings for the interactive `zeroarena init` wizard. Each
// `agent*` function returns a complete agent.ts source. Strategy-specific
// extras (deps, env vars) are returned by their generator alongside.

export type Market = 'spot' | 'perp';
export type LlmProvider = 'anthropic' | 'openai' | 'gemini' | 'claude-code';

export interface Generated {
  agentSource: string;
  extraDeps: Record<string, string>;
  extraEnv: string[];
  readmeNote: string;
}

const ZEROARENA_DEP_VERSION = '^0.2.0';

// ─── rule-based: RSI ──────────────────────────────────────────────────────

export function rsiAgent(params: {
  oversold: number;
  overbought: number;
  sizeFraction: number;
}): Generated {
  return {
    agentSource: `import { Agent, type Action, type Observation } from 'zeroarena';

export class RsiAgent extends Agent {
  constructor(
    public readonly oversold = ${params.oversold},
    public readonly overbought = ${params.overbought},
    public readonly sizeFraction = ${params.sizeFraction},
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
`,
    extraDeps: {},
    extraEnv: [],
    readmeNote: `RSI(14) mean reversion: long when RSI < ${params.oversold}, flat when RSI > ${params.overbought}.`,
  };
}

// ─── rule-based: MACD ─────────────────────────────────────────────────────

export function macdAgent(params: { sizeFraction: number }): Generated {
  return {
    agentSource: `import { Agent, type Action, type Observation } from 'zeroarena';

export class MacdAgent extends Agent {
  constructor(public readonly sizeFraction = ${params.sizeFraction}) {
    super();
  }

  override decide(obs: Observation): Action {
    // Cross above signal → long; cross below → flat (or short on perp).
    const bullish = obs.macd > obs.macdSignal;
    if (bullish) return { direction: 1, size: this.sizeFraction };
    return { direction: 0, size: 0 };
  }

  override toJSON(): Record<string, unknown> {
    return { className: 'MacdAgent', sizeFraction: this.sizeFraction };
  }
}

export default MacdAgent;
`,
    extraDeps: {},
    extraEnv: [],
    readmeNote: `MACD trend follower: long while MACD > signal line, flat otherwise.`,
  };
}

// ─── rule-based: EMA crossover ────────────────────────────────────────────

export function emaAgent(params: { sizeFraction: number }): Generated {
  return {
    agentSource: `import { Agent, type Action, type Observation } from 'zeroarena';

export class EmaCrossoverAgent extends Agent {
  constructor(public readonly sizeFraction = ${params.sizeFraction}) {
    super();
  }

  override decide(obs: Observation): Action {
    // 12-EMA above 26-EMA = uptrend. Long-only on spot.
    if (obs.ema12 > obs.ema26) return { direction: 1, size: this.sizeFraction };
    return { direction: 0, size: 0 };
  }

  override toJSON(): Record<string, unknown> {
    return { className: 'EmaCrossoverAgent', sizeFraction: this.sizeFraction };
  }
}

export default EmaCrossoverAgent;
`,
    extraDeps: {},
    extraEnv: [],
    readmeNote: `EMA(12)/EMA(26) crossover trend follower.`,
  };
}

// ─── LLM: Anthropic API ───────────────────────────────────────────────────

export function llmAnthropic(params: { model: string; sizeFraction: number }): Generated {
  return {
    agentSource: `import Anthropic from '@anthropic-ai/sdk';
import { Agent, type Action, type Observation } from 'zeroarena';

// LLM decides direction per bar. Responses are recorded into agentHash so
// the run remains reproducible by anyone who has the same response log.
// Re-running with a different model output produces a different runHash —
// the cert stays at T2.
export class LlmAgent extends Agent {
  private readonly client: Anthropic | null;
  private readonly model = '${params.model}';
  private readonly sizeFraction = ${params.sizeFraction};
  private readonly decisions: Array<{ index: number; raw: string; direction: -1 | 0 | 1 }> = [];

  constructor() {
    super();
    const key = process.env.ANTHROPIC_API_KEY ?? '';
    this.client = key ? new Anthropic({ apiKey: key }) : null;
  }

  async decide(obs: Observation): Promise<Action> {
    if (!this.client) {
      // Deterministic offline fallback when key is unset.
      const dir: -1 | 0 | 1 = obs.rsi14 < 35 ? 1 : 0;
      this.decisions.push({ index: obs.index, raw: '(no-api-key fallback)', direction: dir });
      return { direction: dir, size: dir ? this.sizeFraction : 0 };
    }
    const prompt = \`Bar \${obs.index}. close \${obs.close.toFixed(2)}, RSI14 \${obs.rsi14.toFixed(1)}, MACD \${obs.macd.toFixed(3)}/sig \${obs.macdSignal.toFixed(3)}, position \${obs.position}. Reply one word: LONG, FLAT.\`;
    const res = await this.client.messages.create({ model: this.model, max_tokens: 8, messages: [{ role: 'user', content: prompt }] });
    const raw = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('').trim().toUpperCase();
    const dir: -1 | 0 | 1 = raw.startsWith('LONG') ? 1 : 0;
    this.decisions.push({ index: obs.index, raw, direction: dir });
    return { direction: dir, size: dir ? this.sizeFraction : 0 };
  }

  override toJSON(): Record<string, unknown> {
    return { className: 'LlmAgent', provider: 'anthropic', model: this.model, sizeFraction: this.sizeFraction, decisions: this.decisions };
  }
}

export default LlmAgent;
`,
    extraDeps: { '@anthropic-ai/sdk': '^0.96.0' },
    extraEnv: ['', '# Anthropic API key for the LLM agent. Unset = use offline RSI fallback.', 'ANTHROPIC_API_KEY='],
    readmeNote: `LLM agent (Anthropic Claude, model ${params.model}). Set ANTHROPIC_API_KEY in .env or it falls back to an offline RSI heuristic.`,
  };
}

// ─── LLM: OpenAI ──────────────────────────────────────────────────────────

export function llmOpenAI(params: { model: string; sizeFraction: number }): Generated {
  return {
    agentSource: `import OpenAI from 'openai';
import { Agent, type Action, type Observation } from 'zeroarena';

export class LlmAgent extends Agent {
  private readonly client: OpenAI | null;
  private readonly model = '${params.model}';
  private readonly sizeFraction = ${params.sizeFraction};
  private readonly decisions: Array<{ index: number; raw: string; direction: -1 | 0 | 1 }> = [];

  constructor() {
    super();
    const key = process.env.OPENAI_API_KEY ?? '';
    this.client = key ? new OpenAI({ apiKey: key }) : null;
  }

  async decide(obs: Observation): Promise<Action> {
    if (!this.client) {
      const dir: -1 | 0 | 1 = obs.rsi14 < 35 ? 1 : 0;
      this.decisions.push({ index: obs.index, raw: '(no-api-key fallback)', direction: dir });
      return { direction: dir, size: dir ? this.sizeFraction : 0 };
    }
    const prompt = \`Bar \${obs.index}. close \${obs.close.toFixed(2)}, RSI14 \${obs.rsi14.toFixed(1)}, MACD \${obs.macd.toFixed(3)}/sig \${obs.macdSignal.toFixed(3)}, position \${obs.position}. Reply one word: LONG, FLAT.\`;
    const res = await this.client.chat.completions.create({ model: this.model, max_tokens: 8, messages: [{ role: 'user', content: prompt }] });
    const raw = (res.choices[0]?.message?.content ?? '').trim().toUpperCase();
    const dir: -1 | 0 | 1 = raw.startsWith('LONG') ? 1 : 0;
    this.decisions.push({ index: obs.index, raw, direction: dir });
    return { direction: dir, size: dir ? this.sizeFraction : 0 };
  }

  override toJSON(): Record<string, unknown> {
    return { className: 'LlmAgent', provider: 'openai', model: this.model, sizeFraction: this.sizeFraction, decisions: this.decisions };
  }
}

export default LlmAgent;
`,
    extraDeps: { openai: '^4.65.0' },
    extraEnv: ['', '# OpenAI API key for the LLM agent. Unset = use offline RSI fallback.', 'OPENAI_API_KEY='],
    readmeNote: `LLM agent (OpenAI ${params.model}). Set OPENAI_API_KEY in .env.`,
  };
}

// ─── LLM: Google Gemini ───────────────────────────────────────────────────

export function llmGemini(params: { model: string; sizeFraction: number }): Generated {
  return {
    agentSource: `import { GoogleGenerativeAI } from '@google/generative-ai';
import { Agent, type Action, type Observation } from 'zeroarena';

export class LlmAgent extends Agent {
  private readonly client: GoogleGenerativeAI | null;
  private readonly model = '${params.model}';
  private readonly sizeFraction = ${params.sizeFraction};
  private readonly decisions: Array<{ index: number; raw: string; direction: -1 | 0 | 1 }> = [];

  constructor() {
    super();
    const key = process.env.GEMINI_API_KEY ?? '';
    this.client = key ? new GoogleGenerativeAI(key) : null;
  }

  async decide(obs: Observation): Promise<Action> {
    if (!this.client) {
      const dir: -1 | 0 | 1 = obs.rsi14 < 35 ? 1 : 0;
      this.decisions.push({ index: obs.index, raw: '(no-api-key fallback)', direction: dir });
      return { direction: dir, size: dir ? this.sizeFraction : 0 };
    }
    const prompt = \`Bar \${obs.index}. close \${obs.close.toFixed(2)}, RSI14 \${obs.rsi14.toFixed(1)}, MACD \${obs.macd.toFixed(3)}/sig \${obs.macdSignal.toFixed(3)}, position \${obs.position}. Reply one word: LONG, FLAT.\`;
    const model = this.client.getGenerativeModel({ model: this.model });
    const res = await model.generateContent(prompt);
    const raw = res.response.text().trim().toUpperCase();
    const dir: -1 | 0 | 1 = raw.startsWith('LONG') ? 1 : 0;
    this.decisions.push({ index: obs.index, raw, direction: dir });
    return { direction: dir, size: dir ? this.sizeFraction : 0 };
  }

  override toJSON(): Record<string, unknown> {
    return { className: 'LlmAgent', provider: 'gemini', model: this.model, sizeFraction: this.sizeFraction, decisions: this.decisions };
  }
}

export default LlmAgent;
`,
    extraDeps: { '@google/generative-ai': '^0.21.0' },
    extraEnv: ['', '# Gemini API key for the LLM agent. Unset = use offline RSI fallback.', 'GEMINI_API_KEY='],
    readmeNote: `LLM agent (Google Gemini ${params.model}). Set GEMINI_API_KEY in .env.`,
  };
}

// ─── LLM: Local Claude Code CLI ───────────────────────────────────────────

export function llmClaudeCode(params: { sizeFraction: number }): Generated {
  return {
    agentSource: `import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent, type Action, type Observation } from 'zeroarena';

const exec = promisify(execFile);

// Uses your local \`claude\` CLI (Claude Code). No API key needed — calls
// inherit your Claude Code subscription. Backtest is slower than API mode
// because each bar spawns a subprocess. Consider \`--backtest-only\` first.
export class LlmAgent extends Agent {
  private readonly sizeFraction = ${params.sizeFraction};
  private readonly decisions: Array<{ index: number; raw: string; direction: -1 | 0 | 1 }> = [];

  async decide(obs: Observation): Promise<Action> {
    const prompt = \`Bar \${obs.index}. close \${obs.close.toFixed(2)}, RSI14 \${obs.rsi14.toFixed(1)}, MACD \${obs.macd.toFixed(3)}/sig \${obs.macdSignal.toFixed(3)}, position \${obs.position}. Reply one word: LONG or FLAT.\`;
    let raw = '';
    try {
      const { stdout } = await exec('claude', ['--print', prompt], { timeout: 30_000 });
      raw = stdout.trim().toUpperCase();
    } catch (err) {
      // CLI missing or timed out → deterministic fallback.
      raw = obs.rsi14 < 35 ? 'LONG' : 'FLAT';
    }
    const dir: -1 | 0 | 1 = raw.startsWith('LONG') ? 1 : 0;
    this.decisions.push({ index: obs.index, raw, direction: dir });
    return { direction: dir, size: dir ? this.sizeFraction : 0 };
  }

  override toJSON(): Record<string, unknown> {
    return { className: 'LlmAgent', provider: 'claude-code', sizeFraction: this.sizeFraction, decisions: this.decisions };
  }
}

export default LlmAgent;
`,
    extraDeps: {},
    extraEnv: [],
    readmeNote: `LLM agent calls your local \`claude\` CLI (Claude Code). Install: https://claude.ai/code. Falls back to RSI heuristic if the CLI is unavailable.`,
  };
}

// ─── empty scaffold ────────────────────────────────────────────────────────

export function customAgent(): Generated {
  return {
    agentSource: `import { Agent, type Action, type Observation } from 'zeroarena';

export class CustomAgent extends Agent {
  override decide(obs: Observation): Action {
    // TODO: your strategy here. Return { direction, size, stopLoss?, takeProfit? }.
    return { direction: 0, size: 0 };
  }

  override toJSON(): Record<string, unknown> {
    return { className: 'CustomAgent' };
  }
}

export default CustomAgent;
`,
    extraDeps: {},
    extraEnv: [],
    readmeNote: `Empty scaffold — implement \`decide()\` in agent.ts.`,
  };
}

// ─── pkg / tsconfig / run / readme generators ──────────────────────────────

export function pkgJson(name: string, extraDeps: Record<string, string>): string {
  return JSON.stringify({
    name,
    version: '0.0.1',
    private: true,
    type: 'module',
    scripts: {
      start: 'tsx run.ts',
      backtest: 'tsx run.ts --backtest-only',
    },
    dependencies: { zeroarena: ZEROARENA_DEP_VERSION, ...extraDeps },
    devDependencies: { tsx: '^4.7.0', typescript: '^5.5.0' },
  }, null, 2) + '\n';
}

export function tsconfigJson(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  }, null, 2) + '\n';
}

export function envFile(params: {
  keyLine: string;
  galileo: { rpc: string; indexer: string; cert: string; inft: string; oracle: string };
  extraEnv: string[];
}): string {
  return [
    `ZA_RPC=${params.galileo.rpc}`,
    `ZA_INDEXER=${params.galileo.indexer}`,
    '',
    '# Your wallet. Signs certify + mintAgent, pays gas, owns the iNFT.',
    `PRIVATE_KEY=${params.keyLine}`,
    '',
    `ZA_ADDR_CERT=${params.galileo.cert}`,
    `ZA_ADDR_INFT=${params.galileo.inft}`,
    `ZA_ADDR_ORACLE=${params.galileo.oracle}`,
    ...params.extraEnv,
    '',
  ].join('\n');
}

export function runTs(params: {
  market: Market;
  initialBalance: number;
  leverage: number;
  takerFeeBps: number;
  slippageBps: number;
  agentName: string;
  mintName: string;
}): string {
  const optsBody =
    params.market === 'perp'
      ? `{ initialBalance: ${params.initialBalance}, market: 'perp', leverage: ${params.leverage}, takerFeeBps: ${params.takerFeeBps}, slippageBps: ${params.slippageBps} }`
      : `{ initialBalance: ${params.initialBalance}, market: 'spot', takerFeeBps: ${params.takerFeeBps}, slippageBps: ${params.slippageBps} }`;

  return `import {
  ZeroArena,
  CANONICAL_DATASETS,
  configFromEnv,
  loadEnv,
  type BacktestOptions,
} from 'zeroarena';
import ${params.agentName} from './agent.js';

const BACKTEST_ONLY = process.argv.includes('--backtest-only');

const OPTS: BacktestOptions = ${optsBody};

async function main() {
  loadEnv();
  const za = new ZeroArena(configFromEnv());

  const { rootHash, candleCount } = CANONICAL_DATASETS['BTCUSDT-15m-spot']!;
  console.log(\`▸ loading dataset (\${candleCount} candles) from 0G Storage…\`);
  const dataset = await za.loadDataset({ rootHash });

  const agent = new ${params.agentName}();
  console.log(\`▸ running backtest…\`);
  const result = await za.backtest(agent, dataset, OPTS);
  console.log(\`  trades:  \${result.trades.length}\`);
  console.log(\`  return:  \${(result.metrics.totalReturnBps / 100).toFixed(2)}%\`);
  console.log(\`  sharpe:  \${(result.metrics.sharpeX1000 / 1000).toFixed(3)}\`);
  console.log(\`  drawdn:  \${(result.metrics.maxDrawdownBps / 100).toFixed(2)}%\`);
  console.log(\`  winrate: \${(result.metrics.winRateBps / 100).toFixed(2)}%\`);
  console.log(\`  runHash: \${result.runHash}\`);

  if (BACKTEST_ONLY) {
    console.log(\`\\n✓ backtest-only. Run \\\`npm start\\\` to certify + mint.\`);
    return;
  }

  console.log(\`\\n▸ certifying on 0G Chain…\`);
  const cert = await za.certify(result);
  console.log(\`  certId: \${cert.certId}\`);
  console.log(\`  tx:     https://chainscan-galileo.0g.ai/tx/\${cert.txHash}\`);

  console.log(\`\\n▸ minting iNFT…\`);
  const inft = await za.mintAgent({ agent, certificate: cert, name: '${params.mintName}' });
  console.log(\`  tokenId: \${inft.tokenId}\`);
  console.log(\`  tx:      https://chainscan-galileo.0g.ai/tx/\${inft.txHash}\`);

  console.log(\`\\n✓ done. Trust tier: T2 (commitment + reproducibility).\`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
`;
}

export function gitignore(): string {
  return ['node_modules/', '.env', '*.log', '.zeroarena/', '*.key', ''].join('\n');
}

export function readme(name: string, strategyNote: string): string {
  return `# ${name}

Zero Arena starter project.

${strategyNote}

## Run

\`\`\`bash
npm install        # if you skipped it during init
npm run backtest   # offline backtest (no chain calls)
npm start          # backtest → certify on 0G Chain → mint iNFT
\`\`\`

You'll see a \`runHash\`, a \`certId\` on \`AgentCertificate\`, and a \`tokenId\` on \`ZeroArenaINFT\`. Every value is linkable on <https://chainscan-galileo.0g.ai>.

## Edit

- \`agent.ts\` — your strategy. Anything in \`toJSON()\` becomes part of \`agentHash\`.
- \`run.ts\` — the pipeline. Backtest options, dataset selection, mint name.

Determinism rules: no \`Math.random()\`, no \`Date.now()\`, no \`for…in\` on objects. Same agent + same dataset → same \`runHash\`.

## Trust tier

Certificates mint at **T2** — commitment on-chain + owner-authorized reproducibility. T3 (TEE attestation via 0G Compute) ships in a future release with no API change.

The AES key for your encrypted run log is at \`~/.zeroarena/keys/agent-<tokenId>.key\` — **keep it** so future verifiers can decrypt.
`;
}
