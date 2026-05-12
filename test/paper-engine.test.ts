// The non-negotiable equivalence test for PaperEngine. RFC-001 makes this
// the load-bearing invariant: given the same (agent, opts, candle sequence),
// PaperEngine processing one bar at a time MUST produce the same `trades`
// list and the same `equityCurve` as the batch BacktestEngine processing
// the whole array at once.
//
// If this test starts failing, the paper-mode runHash diverges from the
// static-cert runHash convention and the on-chain trust chain breaks.

import { keccak256, toUtf8Bytes } from "ethers";
import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent/Agent.js";
import { runBacktest } from "../src/backtest/BacktestEngine.js";
import { PaperEngine } from "../src/backtest/PaperEngine.js";
import { hashTrades, stableStringify } from "../src/backtest/hash.js";
import type { Action, BacktestOptions, Candle, Dataset, Observation } from "../src/types.js";

class RsiAgent extends Agent {
  decide(obs: Observation): Action {
    if (obs.rsi14 < 30) return { direction: 1, size: 0.2 };
    if (obs.rsi14 > 70) return { direction: -1, size: 0.2 };
    return { direction: 0, size: 0 };
  }
}

class MacdFlipAgent extends Agent {
  decide(obs: Observation): Action {
    return obs.macd > obs.macdSignal
      ? { direction: 1, size: 0.5 }
      : { direction: -1, size: 0.5 };
  }
}

function makeSineDataset(market: "spot" | "perp", n = 500): Dataset {
  const candles: Candle[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const base = 100 + Math.sin(i / 17) * 8 + Math.cos(i / 31) * 4 + i * 0.02;
    const open = base;
    const close = base + Math.sin(i / 11) * 0.5;
    const high = Math.max(open, close) + 0.3;
    const low = Math.min(open, close) - 0.3;
    candles[i] = {
      timestamp: 1_700_000_000_000 + i * 3_600_000,
      open,
      high,
      low,
      close,
      volume: 1000 + (i % 50),
      ...(market === "perp" && i % 8 === 0 ? { fundingRate: 0.0001 } : {}),
    };
  }
  const datasetHash = keccak256(toUtf8Bytes(JSON.stringify(candles)));
  return {
    rootHash: "0x" + "00".repeat(32),
    datasetHash,
    candles,
    meta: {
      asset: "BTC",
      quote: "USDT",
      market,
      granularity: "1h",
      source: "synthetic",
      startTs: candles[0]!.timestamp,
      endTs: candles[n - 1]!.timestamp,
    },
  };
}

async function runPaper(
  agent: Agent,
  candles: Candle[],
  opts: BacktestOptions,
): Promise<{ trades: ReturnType<PaperEngine["getTrades"]>; equity: number[] }> {
  const engine = new PaperEngine(agent, opts);
  for (let i = 0; i < candles.length; i++) {
    await engine.onCandleClose(candles[i] as Candle);
  }
  return { trades: engine.getTrades(), equity: engine.getEquityCurve() };
}

describe("PaperEngine — equivalence with BacktestEngine", () => {
  it("produces the same trades + equity for an RSI agent on a 500-candle spot dataset", async () => {
    const dataset = makeSineDataset("spot");
    const opts: BacktestOptions = { initialBalance: 10_000, market: "spot" };

    const batchResult = await runBacktest(new RsiAgent(), dataset, opts);
    const paperResult = await runPaper(new RsiAgent(), dataset.candles, opts);

    // Trade-by-trade equality — strongest possible invariant.
    expect(paperResult.trades.length).toBe(batchResult.trades.length);
    expect(hashTrades(paperResult.trades)).toBe(hashTrades(batchResult.trades));

    // Equity curve identical bar-by-bar.
    expect(paperResult.equity.length).toBe(batchResult.equityCurve.length);
    expect(
      keccak256(toUtf8Bytes(stableStringify(paperResult.equity))),
    ).toBe(keccak256(toUtf8Bytes(stableStringify(batchResult.equityCurve))));
  });

  it("produces the same trades + equity for a MACD flip agent on perp", async () => {
    const dataset = makeSineDataset("perp");
    const opts: BacktestOptions = {
      initialBalance: 10_000,
      market: "perp",
      leverage: 3,
    };

    const batchResult = await runBacktest(new MacdFlipAgent(), dataset, opts);
    const paperResult = await runPaper(new MacdFlipAgent(), dataset.candles, opts);

    expect(paperResult.trades.length).toBe(batchResult.trades.length);
    expect(hashTrades(paperResult.trades)).toBe(hashTrades(batchResult.trades));
    expect(paperResult.equity.length).toBe(batchResult.equityCurve.length);
    expect(
      keccak256(toUtf8Bytes(stableStringify(paperResult.equity))),
    ).toBe(keccak256(toUtf8Bytes(stableStringify(batchResult.equityCurve))));
  });

  it("emits no agent trades before WARMUP=26", async () => {
    const dataset = makeSineDataset("spot");
    const opts: BacktestOptions = { initialBalance: 10_000, market: "spot" };
    const engine = new PaperEngine(new RsiAgent(), opts);
    for (let i = 0; i < 26; i++) {
      await engine.onCandleClose(dataset.candles[i] as Candle);
    }
    // Trades from `open` reason only happen after WARMUP. Before that no
    // agent decision runs; SL/TP can't fire either because there's no
    // open position. So the trade log must be empty.
    expect(engine.getTrades()).toEqual([]);
  });

  it("running PaperEngine twice with same inputs gives identical trade logs", async () => {
    const dataset = makeSineDataset("spot");
    const opts: BacktestOptions = { initialBalance: 10_000, market: "spot" };

    const a = await runPaper(new RsiAgent(), dataset.candles, opts);
    const b = await runPaper(new RsiAgent(), dataset.candles, opts);
    expect(hashTrades(a.trades)).toBe(hashTrades(b.trades));
  });

  it("throws if called after stop()", async () => {
    const dataset = makeSineDataset("spot");
    const opts: BacktestOptions = { initialBalance: 10_000, market: "spot" };
    const engine = new PaperEngine(new RsiAgent(), opts);
    await engine.onCandleClose(dataset.candles[0] as Candle);
    engine.stop();
    await expect(
      engine.onCandleClose(dataset.candles[1] as Candle),
    ).rejects.toThrow(/after stop/);
  });
});
