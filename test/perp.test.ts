import { describe, it, expect } from 'vitest';
import {
  accrueFunding,
  applyPerpAction,
  maybeLiquidate,
  newPerpState,
  perpEquity,
} from '../src/backtest/perp.js';
import type { BacktestOptions } from '../src/types.js';

const baseOpts: BacktestOptions = {
  initialBalance: 10_000,
  market: 'perp',
  leverage: 3,
  feeBps: 0,
  slippageBps: 0,
  liquidationMarginBps: 500,
};

describe('perp portfolio', () => {
  it('opens a long with the requested notional', () => {
    const s = newPerpState(baseOpts);
    const trades = applyPerpAction(s, { direction: 1, size: 1 }, 0, 0, 100);
    expect(trades.length).toBe(1);
    // notional = 10_000 * 1 * 3 = 30_000 → 300 base @ 100
    expect(s.position).toBeCloseTo(300, 6);
    expect(s.entryPrice).toBeCloseTo(100, 6);
  });

  it('flips long → short with two trades', () => {
    const s = newPerpState(baseOpts);
    applyPerpAction(s, { direction: 1, size: 1 }, 0, 0, 100);
    const trades = applyPerpAction(s, { direction: -1, size: 1 }, 1, 0, 100);
    expect(trades.length).toBe(2); // close + reopen
    expect(trades[0]?.reason).toBe('flip');
    expect(trades[1]?.reason).toBe('flip');
    expect(s.position).toBeLessThan(0);
  });

  it('caps leverage at 10x even when the option asks for more', () => {
    const s = newPerpState({ ...baseOpts, leverage: 50 });
    expect(s.leverage).toBe(10);
  });

  it('charges funding to longs when funding rate is positive', () => {
    const s = newPerpState(baseOpts);
    applyPerpAction(s, { direction: 1, size: 1 }, 0, 0, 100);
    const cashBefore = s.cash;
    accrueFunding(s, 100, 0.0001); // 0.01% rate
    const notional = s.position * 100;
    expect(cashBefore - s.cash).toBeCloseTo(notional * 0.0001, 6);
  });

  it('pays funding to shorts when rate is positive (cash increases)', () => {
    const s = newPerpState(baseOpts);
    applyPerpAction(s, { direction: -1, size: 1 }, 0, 0, 100);
    const cashBefore = s.cash;
    accrueFunding(s, 100, 0.0001);
    expect(s.cash).toBeGreaterThan(cashBefore);
  });

  it('liquidates when equity drops below maintenance margin', () => {
    const s = newPerpState({ ...baseOpts, leverage: 10 });
    applyPerpAction(s, { direction: 1, size: 1 }, 0, 0, 100);
    // 10x long entered at 100 — a ~10% adverse move wipes equity. Maintenance
    // margin is 5% of notional, so a price of 91 should trigger liquidation.
    const liq = maybeLiquidate(s, 1, 0, 91);
    expect(liq).not.toBeNull();
    expect(liq?.reason).toBe('liquidation');
    expect(s.position).toBe(0);
  });

  it('does not liquidate within the maintenance buffer', () => {
    const s = newPerpState({ ...baseOpts, leverage: 3 });
    applyPerpAction(s, { direction: 1, size: 1 }, 0, 0, 100);
    const liq = maybeLiquidate(s, 1, 0, 99);
    expect(liq).toBeNull();
    expect(s.position).toBeGreaterThan(0);
  });

  it('reports equity = cash when flat', () => {
    const s = newPerpState(baseOpts);
    expect(perpEquity(s, 12345)).toBe(s.cash);
  });
});
