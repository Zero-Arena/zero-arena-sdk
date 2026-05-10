import { describe, it, expect } from 'vitest';
import { ema, macd, rsi } from '../src/backtest/indicators.js';

describe('rsi (Wilder, 14)', () => {
  // 15 known closes from a textbook RSI(14) example. After 14 deltas, the
  // first computed RSI lands on index 14. Values are stable across runs.
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33,
    44.83, 45.10, 45.42, 45.84, 46.08,
    45.89, 46.03, 45.61, 46.28, 46.28,
  ];

  it('emits 50 for warm-up bars', () => {
    const r = rsi(closes, 14);
    for (let i = 0; i < 14; i++) expect(r[i]).toBe(50);
  });

  it('produces a finite value at the first warm bar', () => {
    const r = rsi(closes, 14);
    expect(Number.isFinite(r[14])).toBe(true);
    expect(r[14]).toBeGreaterThan(0);
    expect(r[14]).toBeLessThan(100);
  });

  it('is byte-stable across runs', () => {
    const a = rsi(closes, 14);
    const b = rsi(closes, 14);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('ema', () => {
  it('seeds with the SMA of the first `period` values', () => {
    const e = ema([1, 2, 3, 4, 5], 5);
    expect(e[4]).toBe(3); // mean(1..5) === 3
  });

  it('matches the canonical EMA recurrence', () => {
    const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const e = ema(closes, 3);
    // After seeding with mean(1,2,3) = 2 at index 2, multiplier k = 2/4 = 0.5.
    // e[3] = (4 - 2) * 0.5 + 2 = 3
    // e[4] = (5 - 3) * 0.5 + 3 = 4
    expect(e[3]).toBeCloseTo(3, 12);
    expect(e[4]).toBeCloseTo(4, 12);
  });
});

describe('macd', () => {
  it('returns macd and signal arrays of the input length', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    const { macd: line, signal } = macd(closes, 12, 26, 9);
    expect(line.length).toBe(60);
    expect(signal.length).toBe(60);
  });

  it('produces finite values once warmed', () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 10) * 5);
    const { macd: line, signal } = macd(closes, 12, 26, 9);
    expect(Number.isFinite(line[50])).toBe(true);
    expect(Number.isFinite(signal[50])).toBe(true);
  });
});
