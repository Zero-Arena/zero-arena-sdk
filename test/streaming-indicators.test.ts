// The mandatory byte-equality test for streaming indicators. RFC-001 makes
// this the non-negotiable invariant: PaperEngine and BacktestEngine MUST
// produce identical observation values at every bar index >= WARMUP=26 when
// fed the same close sequence.
//
// If this test starts failing, the paper trading trust story collapses —
// runHash on a paper run would diverge from the batch reference, and the
// cumulative on-chain commitment becomes meaningless.

import { describe, it, expect } from "vitest";
import { ema, macd, rsi } from "../src/backtest/indicators.js";
import { StreamingIndicators } from "../src/backtest/streaming-indicators.js";
import { WARMUP } from "../src/backtest/BacktestEngine.js";

function makeSineCloses(n: number): number[] {
  // Same deterministic generator the backtest determinism test uses.
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = 100 + Math.sin(i / 17) * 8 + Math.cos(i / 31) * 4 + i * 0.02;
  }
  return out;
}

function assertNear(a: number, b: number, label: string, tol = 1e-12): void {
  // IEEE-754 doubles plus the same arithmetic should yield bit-identical
  // values; the tolerance is a safety belt against any micro-difference in
  // expression evaluation order if the implementation drifts.
  expect(Math.abs(a - b), `${label} drift: ${a} vs ${b}`).toBeLessThan(tol);
}

describe("StreamingIndicators — byte-equality vs batch", () => {
  it("matches batch RSI(14) at every index i >= WARMUP", () => {
    const closes = makeSineCloses(500);
    const batchRsi = rsi(closes, 14);
    const streaming = new StreamingIndicators();
    for (let i = 0; i < closes.length; i++) {
      const obs = streaming.push(closes[i] as number);
      if (i >= WARMUP) assertNear(obs.rsi14, batchRsi[i] as number, `rsi14@${i}`);
    }
  });

  it("matches batch EMA(12) at every index i >= WARMUP", () => {
    const closes = makeSineCloses(500);
    const batchEma = ema(closes, 12);
    const streaming = new StreamingIndicators();
    for (let i = 0; i < closes.length; i++) {
      const obs = streaming.push(closes[i] as number);
      if (i >= WARMUP) assertNear(obs.ema12, batchEma[i] as number, `ema12@${i}`);
    }
  });

  it("matches batch EMA(26) at every index i >= WARMUP", () => {
    const closes = makeSineCloses(500);
    const batchEma = ema(closes, 26);
    const streaming = new StreamingIndicators();
    for (let i = 0; i < closes.length; i++) {
      const obs = streaming.push(closes[i] as number);
      if (i >= WARMUP) assertNear(obs.ema26, batchEma[i] as number, `ema26@${i}`);
    }
  });

  it("matches batch MACD line at every index i >= WARMUP", () => {
    const closes = makeSineCloses(500);
    const batch = macd(closes, 12, 26, 9);
    const streaming = new StreamingIndicators();
    for (let i = 0; i < closes.length; i++) {
      const obs = streaming.push(closes[i] as number);
      if (i >= WARMUP) assertNear(obs.macd, batch.macd[i] as number, `macd@${i}`);
    }
  });

  it("matches batch MACD signal at every index i >= WARMUP (the hardest case)", () => {
    const closes = makeSineCloses(500);
    const batch = macd(closes, 12, 26, 9);
    const streaming = new StreamingIndicators();
    for (let i = 0; i < closes.length; i++) {
      const obs = streaming.push(closes[i] as number);
      if (i >= WARMUP) {
        assertNear(obs.macdSignal, batch.signal[i] as number, `macdSignal@${i}`);
      }
    }
  });

  it("switches to steady-state recurrence after WARMUP_BUFFER closes", () => {
    const closes = makeSineCloses(500);
    const streaming = new StreamingIndicators();
    expect(streaming.isWarm()).toBe(false);
    for (let i = 0; i < 50; i++) streaming.push(closes[i] as number);
    // After 50 pushes, the internal threshold should have flipped.
    expect(streaming.isWarm()).toBe(true);
  });

  it("steady-state values still match batch (sanity after buffer drop)", () => {
    // Sanity check that the post-warmup numerics didn't drift when we
    // dropped the buffer. We push 500 closes; only the last 100 are
    // checked against batch run on the full 500.
    const closes = makeSineCloses(500);
    const batch = macd(closes, 12, 26, 9);
    const batchRsi = rsi(closes, 14);
    const streaming = new StreamingIndicators();
    let lastObs;
    for (let i = 0; i < closes.length; i++) {
      lastObs = streaming.push(closes[i] as number);
      if (i >= 400) {
        assertNear(lastObs.rsi14, batchRsi[i] as number, `rsi14@${i}`);
        assertNear(lastObs.macdSignal, batch.signal[i] as number, `signal@${i}`);
      }
    }
  });

  it("two streaming instances given the same input produce identical observations", () => {
    const closes = makeSineCloses(500);
    const a = new StreamingIndicators();
    const b = new StreamingIndicators();
    for (let i = 0; i < closes.length; i++) {
      const oa = a.push(closes[i] as number);
      const ob = b.push(closes[i] as number);
      expect(oa).toEqual(ob);
    }
  });
});
