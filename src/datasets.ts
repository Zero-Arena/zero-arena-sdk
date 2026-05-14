// Canonical Galileo dataset pointers. Bumped per SDK patch release whenever
// the workspace operator re-uploads via `bacend dataset upload`.
//
// v0.2 scope: only BTC/USDT 15m spot is anchored. 0G/USDT spot and BTC/USDT
// perpetuals are deferred — 0G Storage finalization for ~1MB+ uploads hangs
// on the Galileo testnet, and `fapi.binance.com` is geo-blocked from the
// workspace operator's network. Both come back when the storage testnet
// stabilizes or perp ingest moves to a non-blocked endpoint.

export interface CanonicalDataset {
  rootHash: string;
  datasetHash: string;
  symbol: string;
  interval: string;
  market: 'spot' | 'perp';
  source: string;
  startTs: number;
  endTs: number;
  candleCount: number;
  uploadedAt: string;
}

export const CANONICAL_DATASETS: Record<string, CanonicalDataset> = {
  'BTCUSDT-15m-spot': {
    rootHash: '0xbdf356979b9dac6e742feb0362df54a158c0c358113d15233fa00e74fc5b3ad1',
    datasetHash: '0xef045d37191201052a600853e2a1f4bdcd0f6abed368b71d237e17b573972361',
    symbol: 'BTCUSDT',
    interval: '15m',
    market: 'spot',
    source: 'binance',
    startTs: 1775952000000,
    endTs: 1778553000000,
    candleCount: 2891,
    uploadedAt: '2026-05-12T02:35:51.166Z',
  },
};
