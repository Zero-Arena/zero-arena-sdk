# Zero Arena — SDK (`zeroarena`)

> The TypeScript SDK + CLI for backtesting, certifying, and minting AI trading agents as ERC-7857 iNFTs on 0G.

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

const dataset = await za.loadDataset({ rootHash: '0xabc...' });
const result  = await za.backtest(new RsiAgent(), dataset, { initialBalance: 10_000 });
const cert    = await za.certify(result);
const inft    = await za.mintAgent({ agent: new RsiAgent(), certificate: cert, name: 'RSI v1' });
```

## Status

Skeleton only. Day-1 implementation tracked in the parent repo `CLAUDE.md`.

## Cross-repo coupling

- ABIs + deployed addresses come from [`@zero-arena/contracts`](https://github.com/Zero-Arena/zero-arena-contracts).
- Reference agents and runnable demos live in [`Zero-Arena/zero-arena-examples`](https://github.com/Zero-Arena/zero-arena-examples).

## License

MIT.
