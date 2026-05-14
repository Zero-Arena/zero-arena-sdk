# `zeroarena`

> Verifiable performance for AI trading agents. Backtest deterministically, anchor a certificate on 0G Chain, mint an ERC-7857 iNFT — without leaking your strategy.

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
  oracle: new HttpOracleClient({ url: 'https://your-oracle.example.com' }),
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
- Spot and perpetual futures. Perp adds configurable leverage (≤10×), 8h funding accrual, isolated-margin liquidation.
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

## Known issues

- `@0gfoundation/0g-storage-ts-sdk@1.2.9` transitively depends on an old `axios`. `npm audit` flags it; the vulnerable code path only talks to the 0G endpoints you configure and is not reachable from any consumer input.

## License

MIT.
