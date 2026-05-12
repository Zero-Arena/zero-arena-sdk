// Fee resolution. Single source of truth for the maker/taker rates the
// portfolio code applies. Defaults are Binance VIP-0 (no BNB discount) — the
// worst case a retail user pays, so backtests don't over-state edge.
//
// Sources (see FORMULAS.md 1):
//   Spot:  https://www.binance.com/en/fee/schedule
//   Perp:  https://www.binance.com/en/fee/futureFee
//   Mech.: https://www.binance.com/en/support/faq/detail/360033544231

import type { BacktestOptions, Market } from '../types.js';

export interface ResolvedFees {
  /** Maker fee as a decimal (e.g. 0.0002 for 0.02%). */
  makerRate: number;
  /** Taker fee as a decimal (e.g. 0.0005 for 0.05%). */
  takerRate: number;
}

/** Defaults map: [makerBps, takerBps]. */
const DEFAULTS: Record<Market, [number, number]> = {
  spot: [10, 10], // 0.10% / 0.10%
  perp: [2, 5],   // 0.02% / 0.05%
};

export function resolveFees(opts: BacktestOptions): ResolvedFees {
  const [defMaker, defTaker] = DEFAULTS[opts.market];
  // Backward compat: if the legacy `feeBps` is set and the new fields aren't,
  // use it as the taker fee (and let the maker fee fall to the default).
  const takerBps = opts.takerFeeBps ?? opts.feeBps ?? defTaker;
  const makerBps = opts.makerFeeBps ?? defMaker;
  return {
    makerRate: takerBps === 0 && makerBps === 0 ? 0 : makerBps / 10_000,
    takerRate: takerBps / 10_000,
  };
}
