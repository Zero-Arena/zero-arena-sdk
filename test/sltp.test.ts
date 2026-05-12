import { describe, it, expect } from 'vitest';
import { checkIntraBar } from '../src/backtest/sltp.js';

// Convenience: candle factory.
const c = (open: number, high: number, low: number) => ({ open, high, low });

describe('checkIntraBar — gap rule (open already past level)', () => {
  it('long: gap-down through SL fills at open', () => {
    // Bar opens below SL=95 → fill at open, not at 95.
    const t = checkIntraBar(c(90, 92, 88), { stopLoss: 95, takeProfit: 0 }, 1);
    expect(t).toEqual({ kind: 'stop_loss', fillPrice: 90 });
  });

  it('long: gap-up through TP fills at open', () => {
    const t = checkIntraBar(c(110, 112, 108), { stopLoss: 0, takeProfit: 105 }, 1);
    expect(t).toEqual({ kind: 'take_profit', fillPrice: 110 });
  });

  it('short: gap-up through SL fills at open', () => {
    const t = checkIntraBar(c(110, 112, 108), { stopLoss: 105, takeProfit: 0 }, -1);
    expect(t).toEqual({ kind: 'stop_loss', fillPrice: 110 });
  });

  it('short: gap-down through TP fills at open', () => {
    const t = checkIntraBar(c(90, 92, 88), { stopLoss: 0, takeProfit: 95 }, -1);
    expect(t).toEqual({ kind: 'take_profit', fillPrice: 90 });
  });
});

describe('checkIntraBar — single-side trigger', () => {
  it('long: only SL hit', () => {
    const t = checkIntraBar(c(100, 101, 94), { stopLoss: 95, takeProfit: 110 }, 1);
    expect(t).toEqual({ kind: 'stop_loss', fillPrice: 95 });
  });

  it('long: only TP hit', () => {
    const t = checkIntraBar(c(100, 111, 99), { stopLoss: 90, takeProfit: 110 }, 1);
    expect(t).toEqual({ kind: 'take_profit', fillPrice: 110 });
  });

  it('short: only SL hit (price runs up)', () => {
    const t = checkIntraBar(c(100, 106, 99), { stopLoss: 105, takeProfit: 90 }, -1);
    expect(t).toEqual({ kind: 'stop_loss', fillPrice: 105 });
  });

  it('short: only TP hit (price runs down)', () => {
    const t = checkIntraBar(c(100, 101, 89), { stopLoss: 110, takeProfit: 90 }, -1);
    expect(t).toEqual({ kind: 'take_profit', fillPrice: 90 });
  });
});

describe('checkIntraBar — neither hit', () => {
  it('returns null when neither level is touched', () => {
    expect(checkIntraBar(c(100, 102, 98), { stopLoss: 90, takeProfit: 110 }, 1)).toBeNull();
    expect(checkIntraBar(c(100, 102, 98), { stopLoss: 110, takeProfit: 90 }, -1)).toBeNull();
  });

  it('returns null when SL=TP=0 (both cleared)', () => {
    expect(checkIntraBar(c(100, 200, 50), { stopLoss: 0, takeProfit: 0 }, 1)).toBeNull();
  });
});

describe('checkIntraBar — both could fire (TradingView path inference)', () => {
  it('long, open closer to high → assumes high then low: TP wins', () => {
    // open=100, high=112 (Δ12), low=89 (Δ11) → open is closer to LOW (smaller |Δ|).
    // Flip the bar so open is closer to high:
    // open=100, high=110 (Δ10), low=85 (Δ15) → closer to HIGH → path open→high→low
    // SL=95 (low-side) and TP=108 (high-side) both hit → TP first.
    const t = checkIntraBar(c(100, 110, 85), { stopLoss: 95, takeProfit: 108 }, 1);
    expect(t).toEqual({ kind: 'take_profit', fillPrice: 108 });
  });

  it('long, open closer to low → assumes low then high: SL wins', () => {
    // open=100, high=115 (Δ15), low=92 (Δ8) → closer to LOW → path open→low→high
    const t = checkIntraBar(c(100, 115, 92), { stopLoss: 95, takeProfit: 108 }, 1);
    expect(t).toEqual({ kind: 'stop_loss', fillPrice: 95 });
  });

  it('short, open closer to high → SL (high-side) wins', () => {
    const t = checkIntraBar(c(100, 110, 85), { stopLoss: 105, takeProfit: 92 }, -1);
    expect(t).toEqual({ kind: 'stop_loss', fillPrice: 105 });
  });

  it('short, open closer to low → TP (low-side) wins', () => {
    const t = checkIntraBar(c(100, 115, 92), { stopLoss: 108, takeProfit: 95 }, -1);
    expect(t).toEqual({ kind: 'take_profit', fillPrice: 95 });
  });
});

describe('checkIntraBar — determinism', () => {
  it('returns identical objects on repeated calls', () => {
    const a = checkIntraBar(c(100, 110, 85), { stopLoss: 95, takeProfit: 108 }, 1);
    const b = checkIntraBar(c(100, 110, 85), { stopLoss: 95, takeProfit: 108 }, 1);
    expect(a).toEqual(b);
  });
});
