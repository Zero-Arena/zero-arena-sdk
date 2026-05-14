// Streaming counterparts to the batch indicators in `indicators.ts`. Used by
// PaperEngine to compute RSI / EMA / MACD one candle at a time without
// requiring the full close[] array upfront.
//
// Design — buffer-then-steady:
//
//   The batch versions fill warmup-region values with a single seed (e.g.
//   batch_ema[0..period-1] = mean(closes[0..period-1])). A naive streaming
//   implementation cannot replicate that without seeing the future, so a
//   running-mean fallback would produce different values during warmup,
//   and the MACD signal seed (mean of macd_line[0..8]) would therefore
//   differ — breaking byte-equality.
//
//   Solution: the streaming class buffers closes for the first `WARMUP_BUFFER`
//   pushes (>= the longest sentinel region) and **calls the batch indicators
//   under the hood** during that period. Once the buffer is large enough, it
//   captures the running state (prev EMA values, RSI gain/loss averages,
//   prev signal) and switches to pure O(1) per-push recurrence.
//
//   At any push index i >= WARMUP_BUFFER - 1, the streaming output is the
//   same `Number` as batch indicators run on the equivalent close[] prefix.
//   The CI test in `test/streaming-indicators.test.ts` asserts this.
//
// Why one combined class instead of separate StreamingRSI / EMA / MACD:
//   The MACD signal depends on macd_line values during the slow EMA's
//   warmup, which depend on the slow EMA's seed, which depends on knowing
//   all of closes[0..25] before the first real macd_line value exists. The
//   classes share the same warmup buffer; folding them into one keeps the
//   buffer-management logic in a single place.

import { ema, macd, rsi } from "./indicators.js";

/**
 * Threshold (in closes) at which the streaming class switches from
 * "buffer + batch" mode to "pure streaming recurrence" mode. Must be at
 * least `slowEmaPeriod + signalPeriod` so that the MACD signal recurrence
 * is fully seeded before we discard the buffer.
 */
const WARMUP_BUFFER = 50;

export interface StreamingObservation {
  rsi14: number;
  ema12: number;
  ema26: number;
  macd: number;
  macdSignal: number;
}

/**
 * Streaming RSI(14) + EMA(12) + EMA(26) + MACD(12, 26, 9).
 *
 * Same numerical convention as the batch indicators: the first few outputs
 * during warmup may be sentinel-ish (50 for RSI, running mean for EMA), but
 * `value()` at the same push index always matches the corresponding batch
 * output for indices >= the slow EMA period.
 */
export class StreamingIndicators {
  private readonly rsiPeriod = 14;
  private readonly fastPeriod = 12;
  private readonly slowPeriod = 26;
  private readonly signalPeriod = 9;

  /** Buffered close prices while warming up (length <= WARMUP_BUFFER). */
  private buffer: number[] = [];

  /** True once buffer has been frozen and we're in pure recurrence mode. */
  private warm = false;

  // Steady-state RSI state (Wilder smoothing).
  private prevClose = 0;
  private avgGain = 0;
  private avgLoss = 0;

  // Steady-state EMA / MACD state.
  private prevEma12 = 0;
  private prevEma26 = 0;
  private prevSignal = 0;

  // The most recently emitted observation. Returned by `value()` between pushes.
  private lastObs: StreamingObservation = {
    rsi14: 50,
    ema12: 0,
    ema26: 0,
    macd: 0,
    macdSignal: 0,
  };

  /**
   * Feed one finalized close into the engine. Returns the indicator values
   * AT this push index — i.e. equivalent to `batch_indicators(closes[0..i])[i]`.
   */
  push(close: number): StreamingObservation {
    if (!this.warm) {
      this.buffer.push(close);
      const i = this.buffer.length - 1;

      const r = rsi(this.buffer, this.rsiPeriod);
      const e12 = ema(this.buffer, this.fastPeriod);
      const e26 = ema(this.buffer, this.slowPeriod);
      const m = macd(this.buffer, this.fastPeriod, this.slowPeriod, this.signalPeriod);

      this.lastObs = {
        rsi14: r[i] as number,
        ema12: e12[i] as number,
        ema26: e26[i] as number,
        macd: m.macd[i] as number,
        macdSignal: m.signal[i] as number,
      };

      if (this.buffer.length >= WARMUP_BUFFER) {
        this.freezeWarmup(r, e12, e26, m.macd, m.signal);
      }
      return this.lastObs;
    }

    // Steady state — pure O(1) recurrence.
    const delta = close - this.prevClose;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    this.avgGain = (this.avgGain * (this.rsiPeriod - 1) + gain) / this.rsiPeriod;
    this.avgLoss = (this.avgLoss * (this.rsiPeriod - 1) + loss) / this.rsiPeriod;
    const rsi14 = this.avgLoss === 0
      ? this.avgGain === 0
        ? 50
        : 100
      : 100 - 100 / (1 + this.avgGain / this.avgLoss);
    this.prevClose = close;

    const kFast = 2 / (this.fastPeriod + 1);
    const kSlow = 2 / (this.slowPeriod + 1);
    const kSignal = 2 / (this.signalPeriod + 1);

    this.prevEma12 = (close - this.prevEma12) * kFast + this.prevEma12;
    this.prevEma26 = (close - this.prevEma26) * kSlow + this.prevEma26;
    const macdLine = this.prevEma12 - this.prevEma26;
    this.prevSignal = (macdLine - this.prevSignal) * kSignal + this.prevSignal;

    this.lastObs = {
      rsi14,
      ema12: this.prevEma12,
      ema26: this.prevEma26,
      macd: macdLine,
      macdSignal: this.prevSignal,
    };
    return this.lastObs;
  }

  /** Last observation produced by `push()`. Returns the warmup sentinel before any push. */
  value(): StreamingObservation {
    return this.lastObs;
  }

  /** True once buffer is dropped and we're in O(1) mode. */
  isWarm(): boolean {
    return this.warm;
  }

  // ─── private ──────────────────────────────────────────────────────────

  /**
   * Capture state from the final batch run so subsequent pushes can use the
   * recurrence formulas directly. The captured state MUST be the same numeric
   * value the recurrence would have produced; otherwise the next push's
   * output drifts from batch.
   */
  private freezeWarmup(
    rsiArr: number[],
    ema12Arr: number[],
    ema26Arr: number[],
    macdArr: number[],
    signalArr: number[],
  ): void {
    const i = this.buffer.length - 1;

    // Reconstruct the RSI's running state. The batch RSI's last computed
    // (avgGain, avgLoss) after Wilder smoothing through index i is what we
    // need. We re-derive by replaying the inner loop — cheaper to re-loop
    // than to expose the state from the batch function.
    let gainSum = 0;
    let lossSum = 0;
    for (let j = 1; j <= this.rsiPeriod; j++) {
      const d = (this.buffer[j] as number) - (this.buffer[j - 1] as number);
      if (d > 0) gainSum += d;
      else lossSum += -d;
    }
    let avgGain = gainSum / this.rsiPeriod;
    let avgLoss = lossSum / this.rsiPeriod;
    for (let j = this.rsiPeriod + 1; j <= i; j++) {
      const d = (this.buffer[j] as number) - (this.buffer[j - 1] as number);
      const g = d > 0 ? d : 0;
      const l = d < 0 ? -d : 0;
      avgGain = (avgGain * (this.rsiPeriod - 1) + g) / this.rsiPeriod;
      avgLoss = (avgLoss * (this.rsiPeriod - 1) + l) / this.rsiPeriod;
    }
    this.avgGain = avgGain;
    this.avgLoss = avgLoss;
    this.prevClose = this.buffer[i] as number;

    this.prevEma12 = ema12Arr[i] as number;
    this.prevEma26 = ema26Arr[i] as number;
    this.prevSignal = signalArr[i] as number;

    this.warm = true;
    this.buffer = []; // free the warmup buffer
    // Silence unused-arg lint — macdArr isn't needed because we already
    // captured prevEma12/26/Signal, but keeping the parameter makes the
    // call site self-documenting.
    void macdArr;
  }
}
