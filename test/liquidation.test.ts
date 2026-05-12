// Liquidation math — closed-form Binance USDⓈ-M (isolated margin, one-way).
//
// Formula (FORMULAS.md 4.4):
//   LONG  : LP = (pos·entry − WB − cum) / (pos·(1 − MMR))
//   SHORT : LP = (pos·entry − WB − cum) / (pos·(1 + MMR))
//
// Liquidation fires when:  cash + pos·(mark − entry) ≤ |pos|·mark·MMR − cum

import { describe, it, expect } from 'vitest';
import {
  applyPerpAction,
  liquidationPrice,
  maintenanceMargin,
  maybeLiquidate,
  newPerpState,
  perpEquity,
} from '../src/backtest/perp.js';
import type { BacktestOptions } from '../src/types.js';

const baseOpts: BacktestOptions = {
  initialBalance: 10_000,
  market: 'perp',
  leverage: 10,
  feeBps: 0,
  slippageBps: 0,
  liquidationMarginBps: 500, // MMR = 5%
};

describe('Binance liquidation formula — isolated margin, one-way', () => {
  it('long: closed-form LP matches the equity-based trigger price', () => {
    const s = newPerpState(baseOpts);
    applyPerpAction(s, { direction: 1, size: 1 }, 0, 0, 100);
    // pos = 1000, entry = 100, WB = 10000, MMR = 0.05, cum = 0
    // LP = (1000*100 - 10000 - 0) / (1000 * (1 - 0.05))
    //    = 90000 / 950 ≈ 94.7368421
    const lp = liquidationPrice(s);
    expect(lp).toBeCloseTo(90_000 / 950, 6);

    // Sanity: at the closed-form LP, equity == maintenance margin.
    const eq = perpEquity(s, lp);
    const mm = maintenanceMargin(s, lp);
    expect(eq).toBeCloseTo(mm, 4);
  });

  it('short: closed-form LP matches the equity-based trigger price', () => {
    const s = newPerpState(baseOpts);
    applyPerpAction(s, { direction: -1, size: 1 }, 0, 0, 100);
    // pos = -1000, entry = 100, WB = 10000, MMR = 0.05
    // LP = (-1000*100 - 10000) / (-1000 * (1 + 0.05))
    //    = -110000 / -1050 ≈ 104.7619047
    const lp = liquidationPrice(s);
    expect(lp).toBeCloseTo(110_000 / 1050, 6);

    const eq = perpEquity(s, lp);
    const mm = maintenanceMargin(s, lp);
    expect(eq).toBeCloseTo(mm, 4);
  });

  it('long: liquidation fires at the closed-form LP using bar-low worst-case', () => {
    const s = newPerpState(baseOpts);
    applyPerpAction(s, { direction: 1, size: 1 }, 0, 0, 100);
    const lp = liquidationPrice(s);
    // Bar that touches LP via its low → liquidation triggers.
    const close = lp + 0.5;
    const low = lp - 0.001;
    const liq = maybeLiquidate(s, 1, 0, close, low);
    expect(liq).not.toBeNull();
    expect(liq?.reason).toBe('liquidation');
    expect(s.position).toBe(0);
  });

  it('long: a bar that bottoms ABOVE LP does not liquidate', () => {
    const s = newPerpState(baseOpts);
    applyPerpAction(s, { direction: 1, size: 1 }, 0, 0, 100);
    const lp = liquidationPrice(s);
    const liq = maybeLiquidate(s, 1, 0, lp + 1, lp + 0.5);
    expect(liq).toBeNull();
    expect(s.position).toBeGreaterThan(0);
  });

  it('short: bar high reaching LP triggers liquidation', () => {
    const s = newPerpState(baseOpts);
    applyPerpAction(s, { direction: -1, size: 1 }, 0, 0, 100);
    const lp = liquidationPrice(s);
    const high = lp + 0.001;
    const close = lp - 0.5;
    const liq = maybeLiquidate(s, 1, 0, close, high);
    expect(liq).not.toBeNull();
    expect(s.position).toBe(0);
  });

  it('returns 0 when flat', () => {
    const s = newPerpState(baseOpts);
    expect(liquidationPrice(s)).toBe(0);
  });

  it('non-zero maintenance amount (cum) lowers long LP and raises short LP', () => {
    const withCum: BacktestOptions = { ...baseOpts, maintenanceAmount: 500 };
    const sLong = newPerpState(withCum);
    applyPerpAction(sLong, { direction: 1, size: 1 }, 0, 0, 100);
    // LP = (1000*100 - 10000 - 500) / (1000 * 0.95) = 89500 / 950 ≈ 94.2105
    expect(liquidationPrice(sLong)).toBeCloseTo(89_500 / 950, 6);

    const sShort = newPerpState(withCum);
    applyPerpAction(sShort, { direction: -1, size: 1 }, 0, 0, 100);
    // LP = (-1000*100 - 10000 - 500) / (-1000 * 1.05) = -110500 / -1050 ≈ 105.238
    expect(liquidationPrice(sShort)).toBeCloseTo(110_500 / 1050, 6);
  });
});
