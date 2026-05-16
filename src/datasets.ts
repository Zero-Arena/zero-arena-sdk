// Canonical dataset pointers on 0G mainnet (chainId 16661) Storage. Bumped
// per SDK release whenever the workspace operator re-uploads via
// `npx zeroarena dataset upload <csv>`.
//
// Scope: BTC/USDT 15m spot is the canonical entry. 0G/USDT spot and BTC/USDT
// perpetuals are deferred — `fapi.binance.com` is geo-blocked from several
// deployment regions; perp ingest is canonical from the Singapore-region
// paper-engine host.

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
    rootHash: '0x81a17c8b291b6bf77de03d6042cec83a517958dae5092025ee6b49ddcae962ff',
    datasetHash: '0x19b099f5ef0ceeb9b2d2c00aa339110f44c068f4dd9b1976db04b9733f4d6107',
    symbol: 'BTCUSDT',
    interval: '15m',
    market: 'spot',
    source: 'binance',
    startTs: 1775952000000,
    endTs: 1778557500000,
    candleCount: 2896,
    uploadedAt: '2026-05-16T11:58:00.000Z',
  },
};
