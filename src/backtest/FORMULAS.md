# BacktestEngine Formulas — Sources & Derivations

This document is the single source of truth for every formula the
`BacktestEngine` uses. Each formula is paired with the authoritative reference
that justifies it. Quote any of these in the public README so reviewers can
verify our math without reading code.

> **Scope.** v0.1 ships USDⓈ-M (linear) perpetual math + spot. COIN-M (inverse)
> is out of scope. Cross margin is out of scope — perp is **isolated margin,
> one-way mode** only.

---

## 1. Trading fees

We model **maker** and **taker** fees separately. The default rates are
Binance VIP-0 (no BNB discount), the worst-case a retail user pays — so
backtests don't over-estimate edge.

| Market           | Maker  | Taker  | BNB discount | Effective with BNB (maker / taker) |
| ---------------- | ------ | ------ | ------------ | ---------------------------------- |
| Spot             | 0.10%  | 0.10%  | 25%          | 0.075% / 0.075%                    |
| USDⓈ-M Perp     | 0.02%  | 0.05%  | 10%          | 0.018% / 0.045%                    |

In v0.1 every fill is treated as a **taker** fill (market order against the
current bar's close). When `Action.postOnly === true` (future), the engine will
charge maker fees instead and assume the order rests until filled.

**Fee charged:** `fee = |fillNotional| × feeRate`, deducted from cash for both
sides. (Binance charges fees in the quote asset for USDⓈ-M and the base asset
for spot; we model both as quote-currency for simplicity.)

Sources:
- Binance Spot Fee Schedule: <https://www.binance.com/en/fee/schedule>
- Binance USDⓈ-M Futures Fee Schedule: <https://www.binance.com/en/fee/futureFee>
- Binance Futures fee mechanics & BNB discount:
  <https://www.binance.com/en/support/faq/detail/360033544231>
- Spot BNB discount (25%, VIP-0):
  <https://www.binance.com/en/support/faq/detail/115000583311>

---

## 2. Slippage

Each fill price is moved against the trader by `slippageBps`:

```
fillPrice_buy  = close × (1 + slippageBps / 10_000)
fillPrice_sell = close × (1 − slippageBps / 10_000)
```

Default `slippageBps = 5` (0.05%). This is a static approximation — it does
**not** model book depth, volume impact, or fee tiers. v0.2 may switch to a
volume-aware model (square-root impact). For now the constant matches what
TradingView's broker emulator does by default.

---

## 3. Spot portfolio

Long-only. Short signals are interpreted as "go flat" (no shorting on spot in
v0.1).

| Quantity            | Formula                                           |
| ------------------- | ------------------------------------------------- |
| Equity              | `equity = cash + position × markPrice`            |
| Target position     | `targetPos = (equity × size) / fillPrice`         |
| Buy cash-out        | `cashOut = filled × fillPrice × (1 + feeRate)`    |
| Sell cash-in        | `cashIn  = filled × fillPrice × (1 − feeRate)`    |

`size ∈ [0, 1]` is the fraction of equity targeted. `size = 1` ⇒ all-in.

---

## 4. Perpetual futures portfolio (USDⓈ-M, isolated margin, one-way)

### 4.1 Position notional & PnL

```
notional        = |position| × markPrice
unrealizedPnL   = position × (markPrice − entryPrice)     // signed
equity          = cash + unrealizedPnL                    // a.k.a. marginBalance
```

`position > 0` is long, `position < 0` is short.

### 4.2 Average entry price (when adding to a position)

```
newEntry = (oldEntry × |oldPos| + fillPrice × |added|) / (|oldPos| + |added|)
```

Reducing toward zero leaves `entryPrice` unchanged. Closing fully resets it to
`0`. Flipping = full close + reopen (two trades emitted).

### 4.3 Funding rate accrual

Funding settles every 8 hours at **00:00 / 08:00 / 16:00 UTC**. The amount paid
or received by an open position is:

```
funding = positionNotional × fundingRate     // signed
cash  -= funding
```

When `fundingRate > 0` longs pay shorts; when `fundingRate < 0` shorts pay
longs. The dataset stores the per-bar funding rate; bars without funding leave
the field empty. Snapshotting funding into the dataset (instead of fetching
live) is what keeps `runHash` reproducible.

Sources:
- Binance Futures Funding Rates overview:
  <https://www.binance.com/en/support/faq/introduction-to-binance-futures-funding-rates-360033525031>
- Funding rate formula update notice:
  <https://www.binance.com/en/support/announcement/detail/c00588a7e8504b3eb28d02a2da00530b>

### 4.4 Maintenance margin & liquidation (isolated, one-way)

Binance's general formula for the maintenance margin requirement is:

```
maintenanceMargin = positionNotional × MMR − cum
```

where:

- `MMR` = maintenance margin rate (a function of position notional — Binance
  uses a tiered table per symbol; see leverage & margin page).
- `cum` = "maintenance amount", the cumulative deduction that compensates for
  the lower MMR on the lower tiers. Provided by Binance per tier, per symbol.

A position is liquidated when:

```
marginBalance ≤ maintenanceMargin
   ⇔   cash + position × (markPrice − entryPrice) ≤ |position| × markPrice × MMR − cum
```

Solving for the **liquidation price** in isolated, one-way mode (where
`WB = isolatedWalletBalance = cash`):

```
LONG  (position > 0):
   liqPrice = (position × entryPrice − WB − cum) / (position × (1 − MMR))

SHORT (position < 0):
   liqPrice = (position × entryPrice − WB − cum) / (position × (1 + MMR))
```

(Both denominators are non-zero for any reasonable MMR < 1 and any non-zero
position.)

**v0.1 simplification.** We use a single flat `MMR = 5%` and `cum = 0` for all
position sizes. This is an honest approximation of Binance's lowest-tier MMR
for major USDⓈ-M perps; it slightly under-estimates risk for very large
positions, where Binance's tiered table requires higher MMR. v0.2 ships the
real per-symbol tier table loaded from `examples/data/mmr-tiers.json`.

Sources:
- How to calculate liquidation price (USDⓈ-M):
  <https://www.binance.com/en/support/faq/how-to-calculate-liquidation-price-of-usd%E2%93%A2-m-futures-contracts-b3c689c1f50a44cabb3a84e663b81d93>
- Leverage & Margin page (per-symbol MMR + cum tables):
  <https://www.binance.com/en/support/faq/detail/360033162192>
- Binance Futures liquidation protocols:
  <https://www.binance.com/en/support/faq/binance-futures-liquidation-protocols-360033525271>

---

## 5. Stop-loss / take-profit — intra-bar resolution

Bar-level OHLCV data does not record the order in which `high` and `low` were
visited. We follow TradingView's broker emulator convention, which is the
de-facto standard for OHLC backtesting:

> If the open is closer to the high than to the low, assume the path is
> `open → high → low → close`. Otherwise assume `open → low → high → close`.
> If the open is already past the order price (a gap), fill at the open.

In code (long position with stop `SL < entry < TP`):

| Bar shape (open closer to …) | Inferred path                  | First trigger logic                                                      |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------------------ |
| high                         | open → high → low → close      | TP if `high ≥ TP` else SL if `low ≤ SL`                                  |
| low                          | open → low → high → close      | SL if `low ≤ SL` else TP if `high ≥ TP`                                  |

For a short position the analogous logic applies with `high`/`low` and `SL`/`TP`
roles swapped.

**Gap rule.** If the bar opens past the SL (long) or past the TP (short), the
engine fills at the open price — Binance market orders cannot fill at a price
that no longer exists. This is worse than the protective level but matches
real exchange behaviour.

**Same-bar both-triggered ambiguity.** If both SL and TP would fire on the
same bar and the inferred path doesn't disambiguate, we fall back to the
**worst-case-for-trader** rule: SL wins. This biases backtest results toward
realism, which is what we want.

Sources:
- TradingView Pine Script — strategy concepts:
  <https://www.tradingview.com/pine-script-docs/concepts/strategies/>
- Discussion of the intra-bar accuracy problem:
  <https://medium.com/@kojott/why-your-trading-backtests-might-lying-to-you-the-intrabar-accuracy-problem-68f8b7decdb3>

---

## 6. Performance metrics

### 6.1 Total return

```
totalReturn = (finalEquity − initialBalance) / initialBalance
totalReturnBps = round(totalReturn × 10_000)        // signed
```

### 6.2 Sharpe ratio (annualized, rf = 0)

```
r_t       = ln(equity_t / equity_{t-1})              // per-bar log returns
mean      = Σ r_t / N
std       = sqrt(Σ (r_t − mean)² / N)
sharpe    = (mean / std) × sqrt(barsPerYear)         // sqrt-of-time scaling
sharpeX1000 = round(sharpe × 1000)
```

`barsPerYear = 8760` for 1h candles. Risk-free rate is **0** in v0.1; the
certificate's `sharpeX1000` field is the raw Sharpe of returns. We use log
returns (not arithmetic) to make multi-bar compounding additive.

Sources:
- Sharpe ratio definition: <https://en.wikipedia.org/wiki/Sharpe_ratio>

### 6.3 Sortino ratio (annualized, target = 0)

```
downside_t = min(0, r_t)
DR         = sqrt(Σ downside_t² / N)
sortino    = (mean / DR) × sqrt(barsPerYear)
```

Penalizes only below-target returns, so a strategy with high upside volatility
isn't punished. Target rate of return is **0** in v0.1.

Sources:
- Sortino ratio definition: <https://en.wikipedia.org/wiki/Sortino_ratio>

### 6.4 Maximum drawdown

```
peak_t  = max(equity_0 … equity_t)
DD_t    = (peak_t − equity_t) / peak_t          // ∈ [0, 1]
maxDD   = max(DD_t)
maxDrawdownBps = round(maxDD × 10_000)
```

Standard peak-to-trough definition.

Sources:
- Drawdown definition:
  <https://en.wikipedia.org/wiki/Drawdown_(economics)>

### 6.5 Profit factor

```
grossProfit = Σ pnl_i for pnl_i > 0
grossLoss   = Σ |pnl_i| for pnl_i < 0
profitFactor = grossProfit / grossLoss      // ∞ when no losing trades
```

Per-trade pnl is computed at close-out: realized PnL net of fees on the
closing leg. Profit factor is the ratio every prop firm asks for, so we
expose it directly. We report it as `profitFactorX1000` (capped at 100×) for
on-chain encoding.

### 6.6 Win rate

Per-position win rate: a position is a "win" if its realized PnL on close is
positive. Open legs and partial reductions don't count.

```
winRate = #(positions with realizedPnL > 0) / #(closed positions)
```

---

## 7. Determinism guarantees (CLAUDE.md §7)

Every formula in this document is evaluated using `Number` arithmetic with
fixed iteration order. The engine is byte-deterministic: the same
`(agent, dataset, options)` tuple produces the same `runHash` on every machine
that runs Node.js with IEEE-754 doubles (i.e. all of them). The mandatory
"10 runs, 1 hash" test in `test/backtest.test.ts` enforces this.

If a future formula needs a fixed-point representation (because float ordering
introduces ≥1 ULP drift on some platforms), we'll switch the offending hot
path to integer arithmetic on millionths-of-a-quote-unit, *not* relax the
determinism rule.
