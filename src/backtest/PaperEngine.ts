// PaperEngine — bar-by-bar sibling of BacktestEngine. Same Agent.decide()
// surface, same per-bar event order, same numerical output. The only
// difference: candles arrive one at a time via `onCandleClose(candle)`
// instead of an upfront `Dataset.candles[]` array.
//
// This is the foundation for RFC-001 (paper trading competition). A
// long-running operator daemon subscribes to a real-time exchange feed,
// detects bar closes, and feeds them into a PaperEngine instance. Every N
// candles the engine emits an epoch commit that anchors the cumulative
// hash on-chain via LiveCertificate.update().
//
// Equivalence contract:
//   Given the same (agent, opts, candle sequence), PaperEngine MUST produce
//   the same `trades` array and the same `equityCurve` as `runBacktest()`.
//   The CI test in `test/paper-engine.test.ts` enforces this.

import type { Agent } from "../agent/Agent.js";
import type {
  Action,
  BacktestOptions,
  Candle,
  Market,
  Observation,
  Trade,
} from "../types.js";
import {
  accrueFunding,
  applyPerpAction,
  maybeLiquidate,
  newPerpState,
  perpEquity,
  perpForceCloseAt,
  perpSLTPLevels,
  type PerpState,
} from "./perp.js";
import {
  applySpotAction,
  newSpotState,
  spotEquity,
  spotForceCloseAt,
  spotSLTPLevels,
  type SpotState,
} from "./portfolio.js";
import { checkIntraBar } from "./sltp.js";
import { StreamingIndicators } from "./streaming-indicators.js";

export const PAPER_WARMUP = 26;

export class PaperEngine {
  /** True after construction; flipped to false after stop() / finalize(). */
  private running = true;

  /** Spot or perp portfolio state — only one is active at a time. */
  private readonly spotState: SpotState | null;
  private readonly perpState: PerpState | null;

  /** Streaming RSI/EMA/MACD that mirrors the batch indicators byte-for-byte. */
  private readonly indicators = new StreamingIndicators();

  /** Append-only trade log emitted across all bars since start. */
  private readonly tradeLog: Trade[] = [];

  /** Per-bar equity snapshots, parallel to the sequence of candles received. */
  private readonly equityLog: number[] = [];

  /** Monotonic bar counter — increments once per `onCandleClose`. */
  private barIndex = 0;

  constructor(
    private readonly agent: Agent,
    private readonly opts: BacktestOptions,
  ) {
    if (opts.market === "spot") {
      this.spotState = newSpotState(opts);
      this.perpState = null;
    } else {
      this.perpState = newPerpState(opts);
      this.spotState = null;
    }
  }

  /**
   * Feed one finalized candle into the engine. Mirrors the per-bar event
   * order in BacktestEngine.runBacktest():
   *
   *   spot: SL/TP → agent.decide → applyAction → equity snapshot
   *   perp: funding → liquidation → SL/TP → agent.decide → applyAction → equity snapshot
   *
   * Returns nothing — observe state via getTrades / getEquityCurve /
   * getMetricsInputs after the bar.
   */
  async onCandleClose(candle: Candle): Promise<void> {
    if (!this.running) {
      throw new Error("PaperEngine.onCandleClose called after stop()");
    }
    const i = this.barIndex;
    const obs = this.indicators.push(candle.close);

    if (this.opts.market === "spot") {
      const state = this.spotState!;

      // 1. SL/TP intra-bar check before the agent acts.
      if (state.position > 0) {
        const trig = checkIntraBar(candle, spotSLTPLevels(state), 1);
        if (trig) {
          const t = spotForceCloseAt(
            state,
            trig.fillPrice,
            trig.kind,
            i,
            candle.timestamp,
          );
          if (t) this.tradeLog.push(t);
        }
      }

      // 2. Agent decision at close.
      if (i >= PAPER_WARMUP) {
        const observation: Observation = {
          timestamp: candle.timestamp,
          index: i,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          rsi14: obs.rsi14,
          ema12: obs.ema12,
          ema26: obs.ema26,
          macd: obs.macd,
          macdSignal: obs.macdSignal,
          position: state.position,
          equity: spotEquity(state, candle.close),
          cash: state.cash,
          leverage: 1,
        };
        const action: Action = await Promise.resolve(this.agent.decide(observation));
        const produced = applySpotAction(
          state,
          action,
          i,
          candle.timestamp,
          candle.close,
        );
        for (let j = 0; j < produced.length; j++) {
          this.tradeLog.push(produced[j] as Trade);
        }
      }

      this.equityLog.push(spotEquity(state, candle.close));
    } else {
      const state = this.perpState!;

      // 1. Funding accrues at the start of the bar.
      if (candle.fundingRate !== undefined && candle.fundingRate !== 0) {
        accrueFunding(state, candle.open, candle.fundingRate);
      }

      // 2. Liquidation check using the bar's worst-case mark.
      if (state.position !== 0) {
        const worstMark = state.position > 0 ? candle.low : candle.high;
        const liq = maybeLiquidate(state, i, candle.timestamp, candle.close, worstMark);
        if (liq) this.tradeLog.push(liq);
      }

      // 3. SL/TP intra-bar check (skipped if liquidation already closed).
      if (state.position !== 0) {
        const trig = checkIntraBar(
          candle,
          perpSLTPLevels(state),
          state.position > 0 ? 1 : -1,
        );
        if (trig) {
          const t = perpForceCloseAt(state, trig.fillPrice, trig.kind, i, candle.timestamp);
          if (t) this.tradeLog.push(t);
        }
      }

      // 4. Agent decision at close.
      if (i >= PAPER_WARMUP) {
        const observation: Observation = {
          timestamp: candle.timestamp,
          index: i,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          rsi14: obs.rsi14,
          ema12: obs.ema12,
          ema26: obs.ema26,
          macd: obs.macd,
          macdSignal: obs.macdSignal,
          position: state.position,
          equity: perpEquity(state, candle.close),
          cash: state.cash,
          leverage: state.leverage,
        };
        const action: Action = await Promise.resolve(this.agent.decide(observation));
        const produced = applyPerpAction(
          state,
          action,
          i,
          candle.timestamp,
          candle.close,
        );
        for (let j = 0; j < produced.length; j++) {
          this.tradeLog.push(produced[j] as Trade);
        }
      }

      this.equityLog.push(perpEquity(state, candle.close));
    }

    this.barIndex++;
  }

  /** Mark the engine as stopped so further `onCandleClose` calls throw. */
  stop(): void {
    this.running = false;
  }

  /** Current bar index (number of candles processed so far). */
  getBarIndex(): number {
    return this.barIndex;
  }

  /** Defensive copy of the trade log so callers can hash it without mutation. */
  getTrades(): Trade[] {
    return this.tradeLog.slice();
  }

  /** Defensive copy of the equity curve. */
  getEquityCurve(): number[] {
    return this.equityLog.slice();
  }

  /** Convenience: market mode the engine was constructed with. */
  getMarket(): Market {
    return this.opts.market;
  }
}
