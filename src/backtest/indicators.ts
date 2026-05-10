// Pure deterministic indicator math. No `Math.random`, no `Date.now`, no object
// iteration in the hot path. Same input → same bytes, every time.

/**
 * Wilder RSI with the given period (default 14).
 *
 * Returns an array the same length as `closes`. Bars before the indicator is warm
 * (i < period) are filled with `50` (neutral) so callers don't have to special-case
 * them. The engine still gates `decide` calls on `BacktestEngine.WARMUP`, but
 * leaving a sentinel here is friendlier than NaN.
 */
export function rsi(closes: readonly number[], period = 14): number[] {
  const n = closes.length;
  const out: number[] = new Array(n).fill(50);
  if (n <= period) return out;

  let gainSum = 0;
  let lossSum = 0;

  for (let i = 1; i <= period; i++) {
    const prev = closes[i - 1] as number;
    const curr = closes[i] as number;
    const delta = curr - prev;
    if (delta > 0) gainSum += delta;
    else lossSum += -delta;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = computeRsi(avgGain, avgLoss);

  for (let i = period + 1; i < n; i++) {
    const prev = closes[i - 1] as number;
    const curr = closes[i] as number;
    const delta = curr - prev;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = computeRsi(avgGain, avgLoss);
  }

  return out;
}

function computeRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Exponential moving average. The first `period` outputs are the simple average
 * of the first `period` closes (standard warm-up); subsequent outputs use the
 * canonical EMA recurrence with multiplier `2 / (period + 1)`.
 */
export function ema(closes: readonly number[], period: number): number[] {
  const n = closes.length;
  const out: number[] = new Array(n);
  if (n === 0) return out;

  if (n < period) {
    // Not enough data — fill with the running mean so the array is well-defined.
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += closes[i] as number;
      out[i] = acc / (i + 1);
    }
    return out;
  }

  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i] as number;
  const seed = sum / period;
  for (let i = 0; i < period; i++) out[i] = seed;

  const k = 2 / (period + 1);
  for (let i = period; i < n; i++) {
    const prev = out[i - 1] as number;
    const curr = closes[i] as number;
    out[i] = (curr - prev) * k + prev;
  }
  return out;
}

/**
 * MACD line and signal line. Returns two arrays of the same length as `closes`.
 *
 * - `macd[i] = ema(closes, fast)[i] - ema(closes, slow)[i]`
 * - `signal[i] = ema(macd, signal)[i]`
 */
export function macd(
  closes: readonly number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): { macd: number[]; signal: number[] } {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line: number[] = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) {
    line[i] = (fastEma[i] as number) - (slowEma[i] as number);
  }
  const signal = ema(line, signalPeriod);
  return { macd: line, signal };
}
