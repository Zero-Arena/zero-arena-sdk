# `zeroarena`

> Verifiable performance for AI trading agents. Backtest deterministically, anchor a certificate on 0G Chain, mint an ERC-7857 iNFT — without leaking your strategy.

[![npm](https://img.shields.io/npm/v/zeroarena?color=22c55e&label=npm)](https://www.npmjs.com/package/zeroarena) [![Dashboard](https://img.shields.io/badge/dashboard-live-22c55e)](https://zero-arena-fe.vercel.app) [![Oracle](https://img.shields.io/badge/oracle-live-22c55e)](https://transfer-oracle-production-f390.up.railway.app/health) [![X](https://img.shields.io/badge/X-%400arena__labs-black?logo=x&logoColor=white)](https://x.com/0arena_labs)

## Production endpoints (Galileo testnet, chainId 16602)

| | URL / Address |
| - | - |
| Dashboard | [zero-arena-fe.vercel.app](https://zero-arena-fe.vercel.app) |
| Transfer oracle | `https://transfer-oracle-production-f390.up.railway.app` |
| 0G Chain RPC | `https://evmrpc-testnet.0g.ai` |
| 0G Storage indexer | `https://indexer-storage-testnet-turbo.0g.ai` |
| 0G Explorer | [chainscan-galileo.0g.ai](https://chainscan-galileo.0g.ai) |
| `AgentCertificate` | `0x77f29d2a7BcAC679812d9a0FB1c7508eDA6B087e` |
| `ZeroArenaINFT` | `0xF7162ecbdB11DE4704043D4aF93B4030AD61700e` |
| `ReencryptionOracle` | `0x733667CEBB27e310a8fb60799Af73A8C1fe501b2` |
| `LiveCertificate` | `0x2c71fe022E4698f8fD63384A19Cd69D72a714b4d` |
| `Season` | `0x8fb87CE34b4e8F4C65eeB6752b0168EC37806CF3` |

These addresses ship pre-pinned via `npx zeroarena init` — you usually don't need to copy them by hand.

## Scaffold a project in one command

```bash
npx zeroarena init my-agent
cd my-agent
npm start                # backtest → certify → mint, end-to-end
```

The interactive wizard walks you through:

- **Strategy template** — RSI mean reversion, MACD trend, EMA crossover, LLM-driven, or empty scaffold
- **Market** — spot (long-only) or perpetual futures (leverage, funding, liquidation)
- **LLM provider** (if picked) — Anthropic Claude API, OpenAI, Google Gemini, or local Claude Code CLI (no API key needed)
- **Strategy parameters** — oversold/overbought thresholds, position size, leverage, etc.
- **Wallet setup** — paste your key, generate one with `cast wallet new`, or fill `.env` later

Galileo addresses are pre-pinned. The wizard writes `agent.ts`, `run.ts`, `.env`, `package.json`, and a per-template README.

## Or install manually

```bash
npm install zeroarena
```

## Quick start

```ts
import { ZeroArena, Agent, type Action, type Observation } from 'zeroarena';

class RsiAgent extends Agent {
  decide(obs: Observation): Action {
    if (obs.rsi14 < 30) return { direction: 1, size: 0.5 };
    if (obs.rsi14 > 70) return { direction: 0, size: 0 };
    return { direction: obs.position > 0 ? 1 : 0, size: obs.position > 0 ? 0.5 : 0 };
  }
  override toJSON() { return { className: 'RsiAgent', oversold: 30, overbought: 70 }; }
}

const za = new ZeroArena({
  rpc: 'https://evmrpc-testnet.0g.ai',
  indexer: 'https://indexer-storage-testnet-turbo.0g.ai',
  privateKey: process.env.PRIVATE_KEY!,
  addresses: {
    AgentCertificate: process.env.ZA_ADDR_CERT!,
    ZeroArenaINFT:    process.env.ZA_ADDR_INFT!,
    ReencryptionOracle: process.env.ZA_ADDR_ORACLE!,
  },
});

const dataset = await za.loadDataset({ rootHash: '0xabc…' });
const result  = await za.backtest(new RsiAgent(), dataset, { initialBalance: 10_000, market: 'spot' });
const cert    = await za.certify(result);
const inft    = await za.mintAgent({ agent: new RsiAgent(), certificate: cert, name: 'RSI v1' });
```

`PRIVATE_KEY` is your own wallet — pays gas, signs the tx, owns the iNFT.

## Public API

```ts
class ZeroArena {
  constructor(config: ZeroArenaConfig);
  uploadDataset(csvPath: string): Promise<Dataset>;
  loadDataset(opts: { rootHash: string }): Promise<Dataset>;
  backtest(agent: Agent, dataset: Dataset, opts: BacktestOptions): Promise<BacktestResult>;
  certify(result: BacktestResult, opts?: { trustTier?: TrustTier; attestationHash?: string }): Promise<Certificate>;
  mintAgent(opts: { agent: Agent; certificate: Certificate; name: string; description?: string }): Promise<INFT>;
  transferAgent(opts: { tokenId: bigint; to: string; recipientPubKey: string }): Promise<TransferResult>;
}

abstract class Agent {
  abstract decide(obs: Observation): Promise<Action> | Action;
  toJSON(): Record<string, unknown>;
}
```

`transferAgent()` requires an `OracleClient`. Pass it at construction:

```ts
import { ZeroArena, HttpOracleClient } from 'zeroarena';

const za = new ZeroArena({
  ...,
  oracle: new HttpOracleClient({
    // Production oracle deployed by Zero Arena. Or run your own (see zero-arena-bacend).
    url: 'https://transfer-oracle-production-f390.up.railway.app',
  }),
});
```

## CLI

```bash
npx zeroarena init     my-agent
npx zeroarena dataset  upload ./btcusdt-15m.csv
npx zeroarena backtest --agent ./agent.ts --csv ./btcusdt-15m.csv --balance 10000
npx zeroarena certify  --agent ./agent.ts --csv ./btcusdt-15m.csv
npx zeroarena mint     --agent ./agent.ts --cert 1 --name 'RSI v1' \
  --run-hash 0x… --storage-root 0x… --dataset-hash 0x…
```

CLI reads `process.env`: `PRIVATE_KEY`, `ZA_RPC`, `ZA_INDEXER`, `ZA_ADDR_CERT`, `ZA_ADDR_INFT`, `ZA_ADDR_ORACLE`.

## What you get

- Deterministic `BacktestEngine` (no `Math.random`, no `Date.now`). Same agent + same dataset → same `runHash`, byte-identical.
- **Spot** is the v0.2 canonical market. The perp engine is feature-complete (configurable leverage ≤10×, 8h funding accrual, isolated-margin liquidation) but is officially v0.3 scope — usable today via `market: 'perp'`, not yet the canonical demo path.
- AES-256-GCM encryption on run logs and agent metadata — your code never leaves the machine in plaintext.
- 0G Storage upload via `@0gfoundation/0g-storage-ts-sdk`.
- 0G Chain anchoring of `runHash`, storage root, dataset root, metrics, and `trustTier`.
- ERC-7857 mint + oracle re-encryption transfer.

Model-agnostic: whatever runs inside `decide()` — a rule, an LLM call, an RL policy — is your choice.

## Trust model

Each certificate is tagged with its tier. v0.1 ships T1 + T2:

- **T1 — Commitment.** `runHash` anchored on-chain. Trades cannot be edited after submission.
- **T2 — Reproducibility.** Owner can authorize a verifier with the encrypted run log + AES key; verifier reruns and asserts the same `runHash`.
- **T3 — TEE attestation** *(future)*. Engine + agent run inside a 0G Compute enclave; trustless verification by anyone, agent code never revealed.

## Determinism contract

The verifiability story collapses if backtests aren't reproducible. The engine enforces:

1. No `Math.random` — seed a PRNG if you need randomness.
2. No `Date.now` — use `obs.timestamp`.
3. Fixed iteration order; no `for…in` over objects in the hot path.
4. `runHash = keccak256(agentHash || datasetHash || optionsHash || tradesHash)` with stable JSON for each.

Non-deterministic sources (LLM APIs) are still committed via `runHash`, but the certificate stays at T2 only.

## Security

`npm audit` is clean as of 0.2.1. The package pins `axios>=1.12.0` via npm `overrides` to fix two upstream advisories (GHSA-xx6v-rp6x-q39c, GHSA-43fc-jf86-j433) that arrive transitively through `@0gfoundation/0g-storage-ts-sdk@1.2.9 → open-jsonrpc-provider`. Devtools (`vitest`, `vite`, `esbuild`) are pinned to the latest stable major. Verified after upgrade: 109/109 tests pass, end-to-end download + backtest reproduces the same runHash.

## License

MIT.
