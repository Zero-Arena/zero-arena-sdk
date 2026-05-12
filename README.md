# Zero Arena — SDK (`zeroarena`)

> The TypeScript SDK + CLI for backtesting, certifying, and minting AI trading agents as ERC-7857 iNFTs on 0G — without leaking the agent's strategy.

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
const cert    = await za.certify(result);                                       // T2 by default
const inft    = await za.mintAgent({ agent: new RsiAgent(), certificate: cert, name: 'RSI v1' });
```

The full demo flow lives in [`zero-arena-example-agent/01-rsi-agent-btc-spot`](../examples/01-rsi-agent-btc-spot/).

## CLI

```bash
npx zeroarena --help

# Upload a canonical OHLCV CSV to 0G Storage
npx zeroarena dataset upload ./btcusdt-15m.csv

# Run a backtest end-to-end (agent module is dynamic-imported)
npx zeroarena backtest --agent ./agent.ts --csv ./btcusdt-15m.csv --balance 10000

# Certify a result on-chain
npx zeroarena certify --agent ./agent.ts --csv ./btcusdt-15m.csv

# Mint a passing certificate as an iNFT
npx zeroarena mint --agent ./agent.ts --cert 1 --name 'RSI v1' \
  --run-hash 0x… --storage-root 0x… --dataset-hash 0x…
```

Configuration is read from `.env` — copy [`.env.example`](./.env.example) to start.
The default canonical dataset is **BTC/USDT 15-minute spot** candles, maintained by the [`zero-arena-bacend`](https://github.com/Zero-Arena/zero-arena-bacend) service.

## Transferring an iNFT

`transferAgent()` is the only call that needs an oracle. The SDK never holds the oracle's private key — you point it at a running [`zero-arena-bacend`](../zero-arena-bacend/) `oracle:serve` instance via `HttpOracleClient`:

```ts
import { ZeroArena, HttpOracleClient } from 'zeroarena';

const za = new ZeroArena({
  rpc, indexer, privateKey,
  addresses: { ... },
  oracle: new HttpOracleClient({
    url: 'https://oracle.example.com',
    headers: { authorization: 'Bearer <token>' }, // optional bearer gate
  }),
});

await za.transferAgent({ tokenId, to, recipientPubKey });
```

If you operate the oracle yourself and accept the trusted-stub model, swap in `LocalOracleClient({ privateKey })` at construction — explicit, dev-only, and never auto-loaded from `.env`.

## What the SDK gives you

- A deterministic `BacktestEngine` (no `Math.random`, no `Date.now`, fixed iteration order). Same agent + same dataset → same `runHash`, byte-identical, every time.
- Spot and perpetual-futures markets. Perp adds configurable leverage (capped at 10× in v0.1), 8h funding accrual, and isolated-margin liquidation.
- AES-256-GCM authenticated encryption for run logs and agent metadata. Agent code never leaves your machine in plaintext.
- 0G Storage upload via [`@0gfoundation/0g-storage-ts-sdk`](https://www.npmjs.com/package/@0gfoundation/0g-storage-ts-sdk) (real, not mocked).
- 0G Chain anchoring via `AgentCertificate.submit` — `runHash`, storage root, dataset root, headline metrics, and a `trustTier` tag.
- ERC-7857 iNFT mint + transfer with oracle re-encryption (`ZeroArenaINFT`).

## Trust model

The certificate is tagged with the tier under which it shipped. v0.1 ships **T1 + T2**:

- **T1 — Commitment.** `runHash` anchored on-chain. Trades cannot be edited after submission.
- **T2 — Reproducibility.** Owner can authorize a verifier with the encrypted agent + key; verifier reruns and asserts the same `runHash`.
- **T3 — TEE attestation** *(v0.2)*. `BacktestEngine` + the developer's agent run inside a 0G Compute enclave (Intel TDX + NVIDIA H100/H200) used purely as a confidential-compute substrate. Trustless verification by anyone, agent code never revealed.

The `Certificate` struct already reserves `trustTier` and `attestationHash` slots so v0.2 is wiring, not redesign. Full trust-model table lives in [`CLAUDE.md` 3](../CLAUDE.md).

**The SDK is model-agnostic.** Whatever you put inside `decide()` — a rule, an LLM call, a self-hosted model, an RL policy — is your choice. We don't bundle, recommend, or depend on any model.

## Public API

Locked down per [`CLAUDE.md` 7](../CLAUDE.md). The shapes you can rely on:

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

## Determinism contract

The whole verifiability story collapses if backtests aren't reproducible. The SDK enforces:

1. No `Math.random` in `BacktestEngine`. Use a seeded PRNG if randomness is ever needed.
2. No `Date.now`. Always use `obs.timestamp`.
3. Indicator math uses fixed iteration order. No `for…in` on objects in the hot path.
4. `runHash = keccak256(agentHash || datasetHash || optionsHash || tradesHash)`, with stable JSON for each component.
5. CI runs the same agent + dataset 10 times and asserts every `runHash` matches.

Agents that call out to non-deterministic sources (e.g., LLM APIs) are still cryptographically committed via `runHash` — but the certificate is honest about T2 only. T3 (TEE) lifts this; see [`CLAUDE.md` 14](../CLAUDE.md).

## Cross-repo coupling

- ABIs + deployed addresses come from [`@zero-arena/contracts`](../contracts).
- Reference agents and runnable demos live in [`zero-arena-example-agent`](../examples).

## Known issues

- **Upstream `axios` advisories.** `@0gfoundation/0g-storage-ts-sdk@1.2.9` transitively depends on an old `axios` via `open-jsonrpc-provider`. `npm audit` reports three high-severity advisories in the prototype-pollution / DoS class. The vulnerable code path is the storage SDK's internal JSON-RPC client, which only talks to the 0G indexer + EVM RPC endpoints you configure — there is no user-controlled input route into it from `zeroarena`. We track upstream fixes; v1.2.9 is the latest published.

## License

MIT — see [LICENSE](./LICENSE).
