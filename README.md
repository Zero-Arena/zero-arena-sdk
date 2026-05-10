# Zero Arena — SDK (`zeroarena`)

> The TypeScript SDK + CLI for backtesting, certifying, and minting AI trading agents as ERC-7857 iNFTs on 0G — without leaking the agent's strategy.

```bash
npm install zeroarena
```

```ts
import { ZeroArena, Agent } from 'zeroarena';

const za = new ZeroArena({
  rpc: 'https://evmrpc-testnet.0g.ai',
  indexer: 'https://indexer-storage-testnet-turbo.0g.ai',
  privateKey: process.env.PRIVATE_KEY!,
});

class RsiAgent extends Agent {
  async decide(obs) {
    if (obs.rsi14 < 30) return { direction: 1, size: 0.2 };
    if (obs.rsi14 > 70) return { direction: -1, size: 0.2 };
    return { direction: 0, size: 0 };
  }
}

const dataset = await za.loadDataset({ rootHash: '0xabc...' });           // BTC or 0G, spot or perp
const result  = await za.backtest(new RsiAgent(), dataset, {
  initialBalance: 10_000,
  market: 'spot',                                                          // 'spot' | 'perp'
});
const cert    = await za.certify(result);                                  // tier defaults to T2 in v0.1
const inft    = await za.mintAgent({ agent: new RsiAgent(), certificate: cert, name: 'RSI v1' });
```

## What the SDK gives you

- A deterministic `BacktestEngine` (no `Math.random`, no `Date.now`, fixed iteration order). Same agent + same dataset → same `runHash`, byte-identical, every time.
- Spot and perpetual-futures markets. Perp adds configurable leverage (default 3x, capped at 10x in v0.1), 8h funding accrual, and isolated-margin liquidation.
- Encrypted upload (AES-256-GCM) to 0G Storage. The agent code and run log never hit the network in plaintext.
- Anchor on 0G Chain via `AgentCertificate` — `runHash`, storage root, dataset root, headline metrics, and a `trustTier` tag.
- Mint as an ERC-7857 iNFT. Transfer via the oracle re-encryption flow without ever decrypting metadata off-chain.

## Trust model

The certificate is tagged with the tier under which it shipped. v0.1 ships **T1 + T2**:

- **T1 — Commitment.** `runHash` anchored on-chain. Trades cannot be edited after submission.
- **T2 — Reproducibility.** Owner can authorize a verifier with the encrypted agent + key; verifier reruns and asserts the same `runHash`.
- **T3 — TEE attestation** *(v0.2)*. `BacktestEngine` + the developer's agent run inside a 0G Compute enclave (Intel TDX + NVIDIA H100/H200) used purely as a confidential-compute substrate. Trustless verification by anyone, agent code never revealed.

The `Certificate` struct already reserves `trustTier` and `attestationHash` slots so v0.2 is wiring, not redesign. Full trust-model table lives in the [org README](https://github.com/Zero-Arena).

**The SDK is model-agnostic.** Whatever you put inside `decide()` — a rule, an LLM call, a self-hosted model, an RL policy — is your choice. We don't bundle, recommend, or depend on any model.

## Status

Skeleton only. Day-1 implementation tracked in the parent repo `CLAUDE.md`.

## Cross-repo coupling

- ABIs + deployed addresses come from [`@zero-arena/contracts`](https://github.com/Zero-Arena/zero-arena-contracts).
- Reference agents and runnable demos (BTC + 0G, spot + perp) live in [`Zero-Arena/zero-arena-examples`](https://github.com/Zero-Arena/zero-arena-examples).

## License

MIT.
