# RFC-001 — Paper Trading Competition

|             |                                                |
| ----------- | ---------------------------------------------- |
| **Status**  | Draft                                           |
| **Author**  | Zero Arena Contributors                         |
| **Created** | 2026-05-13                                      |
| **Targets** | v0.3 (post-T3 attestation)                      |
| **Spans**   | sdk · contracts · backend · frontend            |
| **Replaces**| n/a (additive — none of the v0.1 API changes)   |

---

## TL;DR

v0.1 proves that an AI trading agent reproduces a historical run. **A historical run is a single sample of past data — and past data can be cherry-picked.** This RFC adds a second, complementary proof: the agent committed to on-chain *keeps* trading the *unseen future*, candle by candle, while a Merkle root of its growing equity curve is anchored to 0G Chain at fixed cadence. Anyone with a browser sees the live ranking against every other enrolled agent.

The deliverable is three coupled things:

1. **A `PaperEngine`** in the SDK — same `Agent.decide()` surface as the backtest engine, but driven by a real-time WebSocket candle stream instead of a static CSV.
2. **A `LiveCertificate` smart contract** that anchors a per-epoch hash chain extending the existing static `Certificate`. Tamper-evident, append-only, cheap.
3. **A `Season` contract + frontend** that gives every paper run a fixed-rule arena (same dataset spec, same starting balance, same fee schedule) and a public leaderboard updated every 15-minute boundary.

None of the v0.1 public API breaks. The static backtest path stays as is. Paper trading is an opt-in extension a developer requests by calling `za.startPaperRun(certificate, options)` after mint.

---

## 1. Why this exists

v0.1's trust story (CLAUDE.md 3):

> **T1** — Commitment: trades cannot be edited after submission.
> **T2** — Reproducibility: an owner-authorized verifier reruns and asserts the same `runHash`.

Both T1 and T2 cover **historical** data. A motivated skeptic will say:

> *"Your agent might have been hand-tuned to the exact 2,891 candles of `BTCUSDT-15m-spot`. Show me it works on candles **you have never seen**."*

We cannot rebut this with a stronger backtest. The only honest answer is: run the agent on candles that don't yet exist, anchor the result, and let time accumulate.

That is paper trading. The cumulative on-chain commitment after, say, 90 days makes overfit indistinguishable from skill *for the verifier* — because the data the agent traded over wasn't selectable at the moment it committed.

This RFC is the bridge from "verifiable historical commitment" (v0.1) to "verifiable ongoing track record" (v0.3). Live money trading is still further out — Zero Arena never custodies user funds; that path goes through subscriber APIs or DeFi vaults and is out of scope for this RFC.

---

## 2. Three modes of trading — where paper sits

```
                Past data            Realtime data         Realtime data
            ┌──────────────────┐   ┌──────────────────┐  ┌──────────────────┐
            │     BACKTEST     │   │  PAPER TRADING   │  │  LIVE TRADING    │
            ├──────────────────┤   ├──────────────────┤  ├──────────────────┤
  Data      │ Historical CSV   │   │ Binance WS feed  │  │ Binance WS feed  │
  Modal     │ Simulated        │   │ Simulated        │  │ Real (user $)    │
  Fills     │ next-bar @ close │   │ next-bar @ close │  │ exchange order   │
  Risk      │ none             │   │ none             │  │ real             │
  Anchor    │ runHash (one)    │   │ cumulativeHash   │  │ cumulativeHash + │
            │                  │   │ (grows per epoch)│  │   exchange recpts│
  Lives in  │ v0.1             │   │ v0.3 (this RFC)  │  │ post-v1.0        │
            └──────────────────┘   └──────────────────┘  └──────────────────┘
                     ↑                       ↑                     ↑
                     │                       │                     │
                 cherry-pick               can't be             custody/legal
                 attack possible           cherry-picked        becomes the
                                           because future       binding
                                           data unknowable
```

**Why paper before live:**

- Paper requires **no custody work**. Zero Arena never touches user funds, never holds API keys, never executes on an exchange. The trust model stays "operator runs a deterministic image and signs the result."
- Paper is **legally simpler**. No MiFID, no FinCEN, no exchange API agreements.
- Paper is the **right unit for an arena**. Every participant gets identical starting conditions; the only variable is the strategy. Live trading injects variance (slippage tiers, exchange downtime, fee renegotiation) that turns competition into noise.

---

## 3. What paper trading proves that backtest cannot

| Attack | Backtest defense | Paper-trading defense |
| - | - | - |
| Overfit to specific historical window | None — operator could have hand-tuned thresholds to the exact 2891 candles | Future candles are unknowable at the moment of commitment, so the parameters cannot be tuned to them |
| Lookahead bias in the engine itself | Determinism CI test, FORMULAS.md citation chain | Same — engine is unchanged |
| P-hacked feature engineering | None directly (verifier sees `runHash` matches but doesn't know how many siblings the developer discarded) | A "best-of-100" trick is impossible if all 100 siblings must trade live in parallel and the leaderboard ranks all of them |
| Trade selection after the fact | Trades are committed via `tradesHash` in `runHash` | Same — every paper-mode trade is committed as soon as the bar closes |
| Funding-rate manipulation | Dataset is keccak-pinned | Live feed; the live funding rate is whatever the exchange publishes that minute. Manipulating it requires manipulating Binance. |

A motivated reviewer can still attack the **engine** (e.g., "your indicator math has a one-bar lookahead"). That's mitigated by FORMULAS.md citations and the existing determinism test suite. v0.4 lifts it to T3 by running the engine inside a 0G Compute enclave.

Paper trading specifically closes the **selection bias** attack. That is the highest-value attack to close because every other crypto-trader claim in the wild is vulnerable to it.

---

## 4. System architecture

```
                              External
                              ────────
                              Binance USDⓈ-M Spot + Perp
                              WebSocket: wss://stream.binance.com
                              ▲
                              │ realtime candle stream (one tick per bar close)
                              │
┌──────────────────────────────────────────────────────────────────────────┐
│ zero-arena-bacend (operator backplane)                                   │
│                                                                          │
│  ┌─────────────────────┐    ┌────────────────────┐                       │
│  │ Dataset poller      │    │ Paper engine       │  ◀── NEW              │
│  │ (existing)          │    │ daemon             │                       │
│  │                     │    │                    │                       │
│  │ 30-min loop pulls   │    │ Long-running       │                       │
│  │ Binance REST →      │    │ process per        │                       │
│  │ canonical CSV →     │    │ active paper run.  │                       │
│  │ 0G Storage          │    │ Subscribes to WS,  │                       │
│  └─────────────────────┘    │ buffers bars,      │                       │
│                             │ calls SDK engine.  │                       │
│  ┌─────────────────────┐    └─────────┬──────────┘                       │
│  │ Oracle signer       │              │                                  │
│  │ (existing)          │              │                                  │
│  └─────────────────────┘    ┌─────────▼──────────┐                       │
│                             │ Epoch commit       │                       │
│                             │ batcher            │  ◀── NEW              │
│                             │                    │                       │
│                             │ Aggregates epochs  │                       │
│                             │ into ~daily groups,│                       │
│                             │ submits Merkle root│                       │
│                             │ via LiveCertificate│                       │
│                             │ .update()          │                       │
│                             └─────────┬──────────┘                       │
└───────────────────────────────────────│──────────────────────────────────┘
                                        │
                                        │ EIP-1559 tx (Galileo)
                                        ▼
            ┌─────────────────────────────────────────────────────┐
            │ 0G Chain (Galileo testnet, chainId 16602)            │
            │                                                     │
            │  Existing contracts:                                │
            │    AgentCertificate   (one-shot snapshot)           │
            │    ZeroArenaINFT      (mint owner-of)               │
            │    ReencryptionOracle (transfer flow)               │
            │                                                     │
            │  New contracts:        ◀── NEW                       │
            │    LiveCertificate    (per-epoch hash chain)        │
            │    Season             (enrollment + settlement)     │
            │    SeasonLeaderboard  (view-only helper)            │
            └─────────────────────────────────────────────────────┘
                          ▲
                          │
                          │ public reads via viem
                          │
            ┌─────────────────────────────────────────────────────┐
            │ zero-arena-fe                                       │
            │                                                     │
            │  Existing pages:                                    │
            │    /                  Agent Registry                │
            │    /leaderboard       Sorted historical metrics     │
            │    /agent/[slug]      Per-cert detail               │
            │                                                     │
            │  New pages:           ◀── NEW                        │
            │    /season            Active + past seasons         │
            │    /season/[id]       Live leaderboard + countdown  │
            │    /season/[id]/watch Real-time spectator mode      │
            │    /agent/[slug]/live Live equity stream            │
            │                                                     │
            │  Realtime layer:                                    │
            │    Polling viem reads of LiveCertificate every 15s, │
            │    OR optional SSE stream from a small indexer      │
            └─────────────────────────────────────────────────────┘
```

**Three new components, one extended contract:**

1. **Paper engine daemon** (backend) — long-running Node process per active paper run.
2. **Epoch commit batcher** (backend) — operator service that aggregates epochs into daily on-chain commits.
3. **LiveCertificate + Season** (smart contracts) — extend the trust chain into time-series proofs.
4. **Frontend season pages** — make the arena legible.

The SDK gets a thin `startPaperRun()` / `stopPaperRun()` surface and a `PaperEngine` class that the backend daemon embeds. Nothing in the existing `BacktestEngine` changes — the new engine is a sibling, not a replacement.

---

## 5. SDK — the `PaperEngine`

### 5.1 Surface

```ts
// New entry in ZeroArena facade
class ZeroArena {
  // ... existing methods ...

  /**
   * Start a long-running paper trading session bound to an existing iNFT.
   * Returns immediately after the on-chain LiveCertificate.start call confirms.
   * The actual engine runs in the operator's paper-engine daemon; this method
   * is the SDK-side handshake that registers the run on-chain.
   */
  startPaperRun(opts: {
    tokenId: bigint;
    agent: Agent;
    datasetSpec: string; // e.g. "BTCUSDT-15m-spot"
    initialBalance: number;
    duration?: number; // seconds; default = until stopPaperRun
  }): Promise<PaperRun>;

  /** Stop & finalize a paper run. Anchors the closing state on-chain. */
  stopPaperRun(opts: { tokenId: bigint }): Promise<PaperRunResult>;

  /** Read live state of any paper run by tokenId. View-only. */
  getPaperRun(tokenId: bigint): Promise<PaperRunSnapshot>;
}

interface PaperRun {
  tokenId: bigint;
  startedAt: bigint;
  liveCertTx: string; // hash of LiveCertificate.start tx
}

interface PaperRunSnapshot {
  tokenId: bigint;
  startedAt: number;
  lastEpochAt: number;
  epochCount: number;
  cumulativeHash: `0x${string}`;
  liveTotalReturnBps: number;
  liveSharpeX1000: number;
  liveMaxDrawdownBps: number;
  status: "active" | "stopped" | "liquidated";
}
```

### 5.2 PaperEngine class

```ts
export class PaperEngine {
  constructor(
    private readonly agent: Agent,
    private readonly datasetSpec: string,
    private readonly opts: BacktestOptions,
    private readonly snapshotPath: string, // persisted state file
  );

  /** Initialize state — fresh or resumed from disk snapshot. */
  async start(): Promise<void>;

  /** Push one finalized candle into the engine. Idempotent on bar timestamp. */
  async onCandleClose(candle: Candle): Promise<EpochCommit>;

  /** Build the per-epoch commit envelope ready for on-chain anchor. */
  buildEpochCommit(): EpochCommit;

  /** Resume from the last snapshot on disk. Crash-safe. */
  static async resume(snapshotPath: string): Promise<PaperEngine>;
}

interface EpochCommit {
  epochIndex: number;
  windowStartTs: number;
  windowEndTs: number;
  candleCount: number;
  /** keccak256(stableStringify({trades, equityCurve, options, agentHash})). */
  epochHash: `0x${string}`;
  /** Rolling Merkle root after appending this epoch. */
  cumulativeHash: `0x${string}`;
  trades: Trade[];
  equityCurve: number[];
}
```

### 5.3 How it differs from `BacktestEngine`

| Concern | BacktestEngine (v0.1) | PaperEngine (v0.3) |
| - | - | - |
| Input | `Dataset.candles[]` (all upfront) | One candle at a time via `onCandleClose()` |
| Lifecycle | Synchronous, one shot, returns final result | Long-running, callable per bar, never "finishes" |
| State | In-memory only | Persisted to disk after each bar (crash-safe) |
| Warmup | First 26 bars skipped | Same — first 26 bars don't call `agent.decide` |
| Output | Single `BacktestResult` with `runHash` | Stream of `EpochCommit`s with `cumulativeHash` |
| Determinism | Same `(agent, dataset, opts)` → same `runHash` | Same `(agent, candles[0..N], opts)` → same `cumulativeHash` (path-dependent on candle order) |
| Indicator computation | Pre-computed once over entire CSV | Streaming — RSI/EMA/MACD maintain running state across calls |

**Indicators in streaming mode.** This is the only real engineering surprise. `BacktestEngine` calls `rsi(closes, 14)` once at startup. `PaperEngine` cannot — `closes[]` grows by one element per call. We need streaming indicator state:

```ts
class StreamingRSI {
  private readonly period: number;
  private gainSum = 0;
  private lossSum = 0;
  private prevClose: number | null = null;
  private warmCount = 0;

  constructor(period: number) { this.period = period; }

  push(close: number): number | undefined {
    if (this.prevClose === null) {
      this.prevClose = close;
      return undefined;
    }
    const delta = close - this.prevClose;
    const gain = Math.max(0, delta);
    const loss = Math.max(0, -delta);

    if (this.warmCount < this.period) {
      this.gainSum += gain;
      this.lossSum += loss;
      this.warmCount++;
      this.prevClose = close;
      if (this.warmCount < this.period) return undefined;
      // First fully-warm value uses simple average
      const avgGain = this.gainSum / this.period;
      const avgLoss = this.lossSum / this.period;
      return computeRsi(avgGain, avgLoss);
    }

    // Wilder smoothing
    this.gainSum = (this.gainSum * (this.period - 1) + gain) / this.period;
    this.lossSum = (this.lossSum * (this.period - 1) + loss) / this.period;
    this.prevClose = close;
    return computeRsi(this.gainSum, this.lossSum);
  }
}
```

The streaming RSI and the batch RSI **must produce the same value** at every index for the same sequence of closes. CI test: feed both engines the canonical BTCUSDT-15m-spot CSV, assert per-bar match within ULP tolerance.

### 5.4 Determinism contract in real-time mode

The v0.1 determinism rules (CLAUDE.md 7) still apply, plus three new ones:

1. **No `Math.random()` in PaperEngine** — same as backtest.
2. **No `Date.now()` for any time-dependent logic** — use `candle.timestamp` only.
3. **No object iteration in hot path** — same as backtest.
4. **NEW: Bar timestamp is canonical.** A bar at `1715000000000` is committed exactly once; rebroadcasts from Binance with the same `closeTime` are de-duplicated by timestamp before reaching the engine.
5. **NEW: Engine input order matches wall-clock close order.** Out-of-order arrivals (rare but possible on WS hiccup) get buffered and replayed in sorted order before commit.
6. **NEW: Snapshot/resume is byte-deterministic.** Resuming from a snapshot file produces the same `cumulativeHash` as continuing without restart. Tested via "kill -9 mid-run, resume, compare hash" CI scenario.

---

## 6. Storage — per-epoch state on 0G

### 6.1 What an epoch is

An **epoch** is the unit of on-chain commitment. We propose **1 day = 1 epoch** for the v0.3 baseline:

```
1 day = 96 bars (15m granularity)
     = ~96 calls to agent.decide()
     = up to ~96 trades
     = ~10-50 KB of run-log delta per epoch
```

Per-day commit is the right granularity because:

- **Cost.** Anchoring every 15-min boundary on-chain = 96 tx/day per agent. At Galileo gas prices that's ~$0.05/agent/day. For 1000 agents that's $50/day, which is fine for testnet but starts to matter at scale.
- **Latency tolerance.** Most readers don't care if their leaderboard view is 1 hour stale. The PaperEngine itself updates in-memory every 15 minutes; the *on-chain anchor* lags by up to one epoch.
- **Liveness check.** Daily commits make "engine alive" easy to verify — if `lastUpdatedAt > 25h ago`, the operator is delinquent.

If price drops or demand grows, we can bump to 1 epoch = 1 hour (24 commits/day) or even 1 epoch = 1 bar (96 commits/day) without breaking any data structure.

### 6.2 Per-epoch envelope

Each epoch produces a CBOR-or-JSON envelope encrypted with the **same AES key the iNFT mint envelope uses**. The owner re-uses their existing `~/.zeroarena/keys/agent-<tokenId>.key` — no new key material to manage.

```jsonc
{
  "schema": "zeroarena.epoch.v1",
  "tokenId": "42",
  "epochIndex": 12,
  "windowStartTs": 1715472000000,
  "windowEndTs": 1715558400000,
  "candleCount": 96,
  "agentHash": "0x...",
  "optionsHash": "0x...",
  "epochTradesHash": "0x...",        // hash of THIS epoch's trades only
  "cumulativeTradesHash": "0x...",   // hash of all trades since startedAt
  "trades": [/* full trade list for this epoch */],
  "equityCurve": [/* 96 equity points */],
  "metrics": { /* totalReturnBps, sharpeX1000, ... */ },
  "previousCumulativeHash": "0x...",
  "cumulativeHash": "0x..."          // keccak(previousCumulativeHash || epochHash)
}
```

Encrypted with AES-256-GCM (the existing `lib/storage/encryption.ts` envelope format), uploaded to 0G Storage by the operator daemon. The operator pays storage fees; the agent owner gets a "view" link in their dashboard.

### 6.3 Cumulative hash chain

```
epochHash_i = keccak256(stableStringify({
  tokenId, epochIndex_i, windowStartTs_i, windowEndTs_i,
  agentHash, optionsHash,
  epochTradesHash_i, equityCurveHash_i
}))

cumulativeHash_i = keccak256(cumulativeHash_{i-1} || epochHash_i)
cumulativeHash_0 = keccak256(initialCertificateRunHash || epochHash_0)
```

The chain anchors to the static `runHash` from the original `Certificate`, so the live track record is **provably continuous with the historical commitment**. There is no gap where the operator could insert a forged epoch — the first live epoch's `previousCumulativeHash` *is* the static cert's `runHash`.

### 6.4 Storage cost

Per epoch (1 day of 15m bars):
- Per-bar state delta: ~200 bytes (timestamp, trade if any, equity snapshot)
- 96 bars: ~20 KB plaintext
- After AES-256-GCM envelope: ~20.05 KB
- 0G Storage current rate (testnet): negligible

Per agent per year: 365 epochs × 20 KB ≈ 7 MB. Per 1000 agents: 7 GB. Trivial.

---

## 7. Smart contracts — `LiveCertificate` + `Season`

### 7.1 `LiveCertificate`

Append-only per-token state with monotonic epoch counter. Designed to fit one `update` in a single storage slot write where possible.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IZeroArenaINFT} from "./interfaces/IZeroArenaINFT.sol";

contract LiveCertificate is Ownable2Step {
    struct LiveRun {
        uint256 tokenId;
        uint64  startedAt;
        uint64  lastUpdatedAt;
        uint64  epochCount;
        bytes32 cumulativeHash;   // running Merkle root
        int128  liveTotalReturnBps;
        uint128 liveSharpeX1000;
        uint16  liveMaxDrawdownBps;
        uint16  liveWinRateBps;
        uint8   status;           // 0=active, 1=stopped, 2=liquidated
    }

    /// Required relationship: only the owner of the iNFT can start/stop their run.
    IZeroArenaINFT public immutable inft;

    /// tokenId -> live run state
    mapping(uint256 => LiveRun) public runs;

    /// Address(es) allowed to push per-epoch updates. v0.3: operator only.
    /// v0.4 swap: TEE-attested updater whose quote is verified on-chain.
    mapping(address => bool) public authorizedUpdaters;

    event PaperRunStarted(uint256 indexed tokenId, address indexed owner, uint64 startedAt);
    event EpochCommitted(
        uint256 indexed tokenId,
        uint64  indexed epochIndex,
        bytes32 cumulativeHash,
        int128  totalReturnBps,
        uint128 sharpeX1000
    );
    event PaperRunStopped(uint256 indexed tokenId, uint8 status, uint64 stoppedAt);

    constructor(address admin, IZeroArenaINFT _inft) Ownable(admin) {
        inft = _inft;
    }

    function setUpdater(address u, bool allowed) external onlyOwner {
        authorizedUpdaters[u] = allowed;
    }

    /// Start a paper run. Called by the iNFT owner.
    /// `initialCumulativeHash` MUST equal the runHash of the iNFT's underlying certificate.
    function start(uint256 tokenId, bytes32 initialCumulativeHash) external {
        require(inft.ownerOf(tokenId) == msg.sender, "not owner");
        require(runs[tokenId].startedAt == 0, "already started");
        // (sanity: assert initialCumulativeHash matches AgentCertificate.get(certificateOf(tokenId)).runHash)
        runs[tokenId] = LiveRun({
            tokenId: tokenId,
            startedAt: uint64(block.timestamp),
            lastUpdatedAt: uint64(block.timestamp),
            epochCount: 0,
            cumulativeHash: initialCumulativeHash,
            liveTotalReturnBps: 0,
            liveSharpeX1000: 0,
            liveMaxDrawdownBps: 0,
            liveWinRateBps: 0,
            status: 0
        });
        emit PaperRunStarted(tokenId, msg.sender, uint64(block.timestamp));
    }

    /// Operator submits one epoch worth of new state. Idempotent on epochIndex.
    function update(
        uint256 tokenId,
        uint64  epochIndex,
        bytes32 epochHash,
        int128  liveTotalReturnBps,
        uint128 liveSharpeX1000,
        uint16  liveMaxDrawdownBps,
        uint16  liveWinRateBps
    ) external {
        require(authorizedUpdaters[msg.sender], "unauthorized");
        LiveRun storage r = runs[tokenId];
        require(r.startedAt != 0, "not started");
        require(r.status == 0, "not active");
        require(epochIndex == r.epochCount, "epoch out of order");

        // The append step: cumulativeHash := keccak(cumulativeHash || epochHash)
        r.cumulativeHash = keccak256(abi.encodePacked(r.cumulativeHash, epochHash));
        r.epochCount = epochIndex + 1;
        r.lastUpdatedAt = uint64(block.timestamp);
        r.liveTotalReturnBps = liveTotalReturnBps;
        r.liveSharpeX1000 = liveSharpeX1000;
        r.liveMaxDrawdownBps = liveMaxDrawdownBps;
        r.liveWinRateBps = liveWinRateBps;

        emit EpochCommitted(tokenId, epochIndex, r.cumulativeHash, liveTotalReturnBps, liveSharpeX1000);
    }

    /// Stop a run. Owner-only. Sets status to "stopped" (1).
    function stop(uint256 tokenId) external {
        require(inft.ownerOf(tokenId) == msg.sender, "not owner");
        LiveRun storage r = runs[tokenId];
        require(r.status == 0, "not active");
        r.status = 1;
        emit PaperRunStopped(tokenId, 1, uint64(block.timestamp));
    }
}
```

**Gas envelope (estimated, mainnet rates):**
- `start()`: ~70k gas (one SSTORE-cold + event)
- `update()`: ~50k gas (one SSTORE-warm + event + keccak)
- `stop()`: ~30k gas (one SSTORE-warm + event)

At 3 gwei (Galileo testnet), 365 updates/year = ~5.5M gas = a fraction of a cent. Operator-funded so the agent owner sees zero gas cost during their run.

### 7.2 `Season`

```solidity
contract Season is Ownable2Step {
    struct SeasonSpec {
        uint256 id;
        bytes32 datasetSpec;     // keccak("BTCUSDT-15m-spot")
        uint64  initialBalance;
        uint16  feeBps;
        uint16  slippageBps;
        uint8   market;          // 0=spot, 1=perp
        uint8   maxLeverage;     // 1..10
        uint64  startTime;
        uint64  endTime;
        uint256 prizePool;       // wei in chain native token
        address creator;
        bool    settled;
    }

    uint256 public nextSeasonId = 1;
    mapping(uint256 => SeasonSpec) public seasons;

    /// seasonId -> tokenId -> enrolled?
    mapping(uint256 => mapping(uint256 => bool)) public enrolled;
    /// seasonId -> all enrolled tokens (for off-chain enumeration)
    mapping(uint256 => uint256[]) public participants;

    LiveCertificate public immutable live;

    event SeasonCreated(uint256 indexed id, bytes32 datasetSpec, uint64 startTime, uint64 endTime, uint256 prizePool);
    event Enrolled(uint256 indexed seasonId, uint256 indexed tokenId, address indexed owner);
    event Settled(uint256 indexed seasonId, uint256[] winners);

    constructor(address admin, LiveCertificate _live) Ownable(admin) {
        live = _live;
    }

    function createSeason(SeasonSpec calldata spec) external payable onlyOwner returns (uint256 id) {
        require(spec.startTime > block.timestamp, "start in past");
        require(spec.endTime > spec.startTime, "bad window");
        require(msg.value >= spec.prizePool, "prize pool underfunded");
        id = nextSeasonId++;
        seasons[id] = SeasonSpec({
            id: id,
            datasetSpec: spec.datasetSpec,
            initialBalance: spec.initialBalance,
            feeBps: spec.feeBps,
            slippageBps: spec.slippageBps,
            market: spec.market,
            maxLeverage: spec.maxLeverage,
            startTime: spec.startTime,
            endTime: spec.endTime,
            prizePool: spec.prizePool,
            creator: msg.sender,
            settled: false
        });
        emit SeasonCreated(id, spec.datasetSpec, spec.startTime, spec.endTime, spec.prizePool);
    }

    function enroll(uint256 seasonId, uint256 tokenId) external {
        SeasonSpec memory s = seasons[seasonId];
        require(block.timestamp < s.startTime, "enrollment closed");
        require(live.inft().ownerOf(tokenId) == msg.sender, "not owner");
        require(!enrolled[seasonId][tokenId], "already enrolled");
        enrolled[seasonId][tokenId] = true;
        participants[seasonId].push(tokenId);
        emit Enrolled(seasonId, tokenId, msg.sender);
    }

    /// Anyone can call after endTime. Reads top-3 by liveTotalReturnBps and pays out.
    /// Off-chain: indexer pre-computes the sorted list to keep the on-chain sort cheap.
    /// On-chain: we trust the caller's sorted hint and verify it in constant time.
    function settle(uint256 seasonId, uint256[] calldata sortedTokens) external {
        SeasonSpec storage s = seasons[seasonId];
        require(block.timestamp > s.endTime, "season not over");
        require(!s.settled, "already settled");
        require(sortedTokens.length <= participants[seasonId].length, "bad hint");

        // Verify monotonicity of the hint (returnBps strictly decreasing)
        int128 prev = type(int128).max;
        for (uint i = 0; i < sortedTokens.length; i++) {
            (, , , , , int128 ret, , , , ) = live.runs(sortedTokens[i]);
            require(ret <= prev, "hint not sorted");
            require(enrolled[seasonId][sortedTokens[i]], "not enrolled");
            prev = ret;
        }

        s.settled = true;
        // Pay top-3 weighted 50/30/20
        uint256 pool = s.prizePool;
        if (sortedTokens.length >= 1) _pay(sortedTokens[0], pool * 50 / 100);
        if (sortedTokens.length >= 2) _pay(sortedTokens[1], pool * 30 / 100);
        if (sortedTokens.length >= 3) _pay(sortedTokens[2], pool * 20 / 100);

        emit Settled(seasonId, sortedTokens);
    }

    function _pay(uint256 tokenId, uint256 amount) private {
        address to = live.inft().ownerOf(tokenId);
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "pay failed");
    }
}
```

**Design notes:**

- **Off-chain sort.** Sorting all participants on-chain is O(N²) in storage reads and breaks at >100 entries. Instead the caller provides a sorted hint and the contract verifies monotonicity in O(N). Indexer can compute the hint in milliseconds.
- **No anti-Sybil at v0.3.** Anyone can enroll any iNFT they own. A motivated attacker mints 1000 iNFTs of the same agent with tiny parameter tweaks. Mitigation: require enrollment fee, OR require iNFT to be older than the season creation timestamp. Both are 1-line additions.
- **Prize denomination is chain-native.** v0.3 uses Galileo's 0G token; v1.0 will support arbitrary ERC-20 prize pools.

---

## 8. Cryptographic chain — extending `runHash`

The static v0.1 `runHash` becomes the genesis of the live chain:

```
                Static Certificate (v0.1, frozen)
              ┌──────────────────────────────────┐
              │ runHash          = R₀             │
              │ datasetHash      = D              │
              │ trustTier        = T2             │
              │ submittedAt      = 2026-05-10     │
              └────────┬─────────────────────────┘
                       │
                       │ R₀ is the genesis "previousCumulativeHash"
                       │
                       ▼
                Live track record (v0.3, growing)
              ┌──────────────────────────────────┐
              │ epoch 0 → epochHash = E₀          │
              │   cumulativeHash    = H₀ = keccak(R₀ || E₀)
              │                                   │
              │ epoch 1 → epochHash = E₁          │
              │   cumulativeHash    = H₁ = keccak(H₀ || E₁)
              │                                   │
              │ ...                               │
              │ epoch N → epochHash = Eₙ          │
              │   cumulativeHash    = Hₙ = keccak(Hₙ₋₁ || Eₙ)
              └────────┬─────────────────────────┘
                       │
                       │ Hₙ is what `LiveCertificate.runs(tokenId).cumulativeHash` returns
                       ▼
                Anchored on chain at epoch N
```

**Verification flow for a third party:**

```
1. Look up runs[tokenId].cumulativeHash   → on-chain Hₙ
2. Fetch all epoch envelopes from 0G Storage  → E₀, E₁, ... Eₙ
3. Look up AgentCertificate.get(certId).runHash  → R₀
4. Replay: H'ᵢ = keccak(H'ᵢ₋₁ || Eᵢ), with H'₋₁ = R₀
5. Assert Hₙ == H'ₙ
```

If any single epoch envelope is missing or tampered with, the replay produces a different `H'ₙ`. Operator cannot forge — every epoch is committed before the next bar closes, so they cannot edit history retroactively.

**T2.5 — Live Reproducibility.** A natural new tier slot:

| Tier | Mechanism | Available |
| - | - | - |
| T1 | Commitment | v0.1 |
| T2 | Owner-authorized reproducibility | v0.1 |
| **T2.5** | **Append-only live track record anchored on chain** | **v0.3 (this RFC)** |
| T3 | TEE attestation | v0.4 |

T2.5 doesn't require the owner to share anything with anyone. The track record is publicly verifiable from chain + storage. What's still owner-controlled: the *agent code* itself. If a verifier wants to run the agent themselves to *predict* future trades, they still need T2 access.

---

## 9. Frontend — the arena experience

### 9.1 New routes

| Route | What it shows |
| - | - |
| `/season` | Index of every season (active + settled). Highlight "live now" + countdown to next start. |
| `/season/[id]` | The live leaderboard for one season. Refreshes every 15s. Top-3 podium + full ranking table. |
| `/season/[id]/watch` | Spectator deep-dive: pick 1-5 agents, see their equity curves overlaid in real-time. |
| `/agent/[slug]/live` | Per-agent live page: equity curve since paper run start, epoch-by-epoch commit log, link to seasons enrolled. |

### 9.2 Component design — `LiveTicker`

The interesting new client component. Subscribes to chain via wagmi (or polling viem), pushes new epochs into a Zustand store, fans out to chart + leaderboard subscribers.

```ts
// app/_components/LiveTicker.tsx
"use client";

import { useEffect } from "react";
import { useChainId, useWatchContractEvent } from "wagmi";
import { LIVE_CERTIFICATE_ABI } from "@/lib/chain/contracts";
import { useLiveStore } from "@/lib/store/live";

export default function LiveTicker({ seasonId }: { seasonId: bigint }) {
  const addEpoch = useLiveStore((s) => s.addEpoch);

  useWatchContractEvent({
    address: LIVE_CERTIFICATE_ADDRESS,
    abi: LIVE_CERTIFICATE_ABI,
    eventName: "EpochCommitted",
    onLogs: (logs) => {
      for (const log of logs) {
        if (!log.args) continue;
        addEpoch({
          tokenId: log.args.tokenId!,
          epochIndex: Number(log.args.epochIndex),
          cumulativeHash: log.args.cumulativeHash!,
          totalReturnBps: Number(log.args.totalReturnBps),
          sharpeX1000: Number(log.args.sharpeX1000),
          timestamp: Date.now(),
        });
      }
    },
  });

  return null; // headless
}
```

Mounted once on `/season/[id]` pages. Children consume via `useLiveStore()`.

### 9.3 Visual specs

**Season leaderboard — live state:**

```
┌──── Season 1 — BTC/USDT Spot — Day 12 of 30 ─────────────── ● LIVE ──┐
│                                                                       │
│  Started 2026-05-01 00:00 UTC      Ends 2026-05-31 00:00 UTC          │
│  Prize pool: 1,000 0G              18 days remaining                  │
│                                                                       │
│  ╭─────────────╮  ╭─────────────╮  ╭─────────────╮                    │
│  │     #2      │  │     #1      │  │     #3      │                    │
│  │  Agent #287 │  │  Agent #142 │  │  Agent #318 │                    │
│  │  ░░░░░░░    │  │  ░░░░░░░    │  │  ░░░░░░░    │   ← live equity   │
│  │  +11.8%  ↑  │  │  +14.3%  ↑  │  │  +9.2%   ↑  │     curve         │
│  │  Sharpe 1.9 │  │  Sharpe 2.4 │  │  Sharpe 1.4 │     sparklines    │
│  ╰─────────────╯  ╰─────────────╯  ╰─────────────╯                    │
│                                                                       │
│  Full ranking (47 agents enrolled)              [sorted by 30D return]│
│  ─────────────────────────────────────────────────────────────────── │
│  #  Agent          Live PnL    Sharpe   MaxDD    Win    Last Epoch   │
│  1  @rsiking       +14.3% ↑    2.4      -4.2%    63%    just now     │
│  2  @claude_trader +11.8% ↑    1.9      -8.1%    58%    just now     │
│  3  @momentum_3x   +9.2%  ↑    1.4      -12.4%   54%    just now     │
│  ...                                                                  │
│  47 @yolo          -45.2% ↓    LIQ      -68%      33%   2h ago ✗     │
│                                                                       │
│  [Watch Live →]  [Enroll Your Agent]                                  │
└───────────────────────────────────────────────────────────────────────┘
```

**Watch mode (1-5 agents overlaid):**

```
┌─ Watching: @rsiking + @claude_trader + @momentum_3x ──────────────────┐
│                                                                       │
│      $14,300 ┤                                       ╭─── rsiking     │
│              │                            ╭──────────╯                │
│              │              ╭─────────────╯                           │
│      $11,800 ┤        ╭─────╯ ╭────────╮  ╭─── claude_trader          │
│              │   ╭────╯       │        ╰──╯                           │
│      $10,000 ┼───╯─────────────────────────────────────  start         │
│              │         ╭────────╮              ╭─── momentum_3x       │
│       $9,200 ┤    ╭────╯        ╰──────────────╯                      │
│              │                                                        │
│              └────────────────────────────────────────────            │
│              May 1                  May 12                            │
│                                                                       │
│  Last epoch update: 14 seconds ago                                    │
└───────────────────────────────────────────────────────────────────────┘
```

That layout is doable with `lightweight-charts` overlaying multiple series in one pane.

### 9.4 Performance budget

- **Page load on `/season/[id]`:** SSR with `revalidate = 15` so leaderboard data is fetched server-side and cached briefly. Initial paint ≤ 800ms.
- **Live ticker:** wagmi `useWatchContractEvent` polls the RPC every block (~2s on Galileo). New epochs land within ~5s of on-chain confirmation.
- **Chart redraw cost:** 1000 agents × 96 points = 96k data points. Lightweight-charts handles that. For watch mode (1-5 agents) it's trivial.

If RPC event polling becomes a bottleneck (>1000 active agents producing >10 commits/min combined), introduce a tiny indexer service: subscribe to `EpochCommitted` events, push to a Postgres time-series table, expose a Server-Sent Events stream to the FE. The contracts don't change.

---

## 10. Reliability & operations

Paper trading introduces an SLA the operator did not have before. With v0.1, if the dataset poller crashes, you re-run it later. With v0.3, if the paper engine crashes, **the agent misses real candles** and its competition standing is hurt.

### 10.1 Engine resilience

| Failure mode | Detection | Recovery |
| - | - | - |
| Process crash (segfault, OOM) | systemd / supervisor restart | Resume from disk snapshot — same `cumulativeHash` |
| Network blip on WebSocket | WS keepalive timeout | Reconnect, fetch missed bars via REST, replay in order |
| Stale snapshot (clock skew, etc.) | startup validates snapshot vs. current block timestamp | If gap > 2h: refuse to resume, alert operator (manual decision) |
| 0G Storage upload fail | Try 3x with exponential backoff | If all fail: hold epoch in memory, retry on next bar |
| 0G Chain RPC down | Retry with backoff | If down > 1h: pause all updates, alert; queued epochs apply when RPC returns |
| Operator wallet runs out of gas | Pre-flight balance check before submit | Alert + auto-refill from treasury if integrated, else manual top-up |

### 10.2 Per-epoch commit batcher

Instead of submitting one `LiveCertificate.update()` per bar (96 tx/day per agent), the batcher aggregates a full epoch's worth of computation into one tx submitted at the day boundary. This is the right tradeoff:

- **Pro:** 96× lower tx count, ~$0.50 → ~$0.005 gas per agent per day at testnet rates
- **Pro:** Operator can checkpoint to Galileo at a graceful cadence even if RPC is briefly down
- **Con:** Leaderboard lags up to one epoch (24h in v0.3 baseline)

The lag is fine. Most reviewers want to see the *track record over weeks*, not real-time PnL ticking. We can offer a "real-time mode" later (per-bar commit) at higher gas cost as a premium-tier feature.

### 10.3 Disaster recovery

What if the operator's box dies and the snapshot is lost?

1. Last committed epoch `i` is on-chain (`runs[tokenId].epochCount`).
2. Operator pulls all `EpochCommitted` events since `start()` from Galileo.
3. For each epoch, fetches the encrypted envelope from 0G Storage (the rootHash is in the event log).
4. Owner provides AES key — operator cannot decrypt without it.
5. Engine resumes from epoch `i+1` with the chain's `cumulativeHash` as starting state.

The owner's AES key is the only thing the operator cannot recover independently. That's the right shape — the operator is a TEE-substitutable role, not a custodian.

---

## 11. Trust-model interactions

### 11.1 Where T2.5 sits

Paper trading proves something fundamentally different from T2:

> **T2:** "The agent owner authorizes me. I run the agent on the historical dataset. My `runHash` matches the on-chain commitment."
>
> **T2.5:** "I look at any block explorer. I see the agent committed bar 1, 2, ... N, with cumulative hash anchored at each step. The commits were made before the next bar closed. I trust the operator was honest about ordering."
>
> **T3 (v0.4):** "The operator's behavior was attested by a TEE quote. I no longer need to trust the operator at all."

T2.5 still has one assumption: **the operator is honest about WebSocket data ordering**. They could, in theory, conspire with an agent owner to:

1. Watch incoming bar B at time T.
2. If B is bad for agent A's open position, "process" bar B+1 first using the agent's hypothetical winning trade.
3. Backfill bar B with the original behavior.

This requires the operator to be in collusion with the agent owner *and* to violate the engine's deterministic order. We can detect this by:

- Cross-checking bar timestamps against the public Binance candle feed (anyone can do this)
- Cross-checking the commit time on Galileo (must be > bar close timestamp)

If operator commits *before* the bar actually closed, that's provable manipulation. We tolerate this in v0.3 (single operator, semi-trusted) and close it in v0.4 by running the engine inside a TEE.

### 11.2 What v0.4 (T3) adds on top

```
v0.3 paper engine                  v0.4 TEE-attested paper engine
─────────────────────────          ──────────────────────────────────
Runs in operator process           Runs in 0G Compute enclave
                                   (Intel TDX + NVIDIA H100/H200)

Each EpochCommit signed             Each EpochCommit signed by the
by operator wallet                  TEE quote, verifiable on-chain

Trust assumption:                   Trust assumption:
  operator honest about             enclave measurement matches
  ordering + timing                 the published deterministic
                                    engine Docker image

Operator could (in theory)          Operator cannot manipulate
manipulate by conspiring with       ordering without breaking the
the agent owner                     enclave attestation
```

No SDK or contract surface changes. The `EpochCommit` envelope grows an `attestationQuote` field; the `LiveCertificate.update` function accepts the quote and forwards to an on-chain verifier. The same contracts work for v0.3 (operator-signed) and v0.4 (TEE-signed).

---

## 12. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
| - | - | - | - |
| Operator daemon goes down mid-season → agent ranking permanently hurt | M | H | Multi-region operator, snapshot every bar, alert on >2-bar gap |
| Sybil attack: 1000 sibling agents with tiny tweaks all enroll | H | M | Enrollment fee in season pool; require iNFT older than season creation |
| Lookahead exploit: operator commits AFTER seeing next bar | L | H | Cross-check commit timestamp > bar close timestamp; flag delinquent operator on indexer |
| Engine non-determinism between sessions | M | H | "Resume from snapshot, compare hash" CI; bit-identical Node version requirement |
| Liquidity / slippage divergence from real markets | L | L | We model conservative VIP-0 fees + 5bps slippage. Less optimistic than reality. |
| Funding rate manipulation | L | M | Use Binance-published funding only; pin per-bar via existing dataset hash mechanism |
| Agent owner deletes AES key, can't decrypt their own run log | M | L | Detail page warns "back up your key" at mint time; the on-chain track record remains valid |
| Operator double-charges gas (over-priced settle) | L | L | `settle()` is permissionless; anyone can call. Operator never controls payout. |
| FE shows wrong leaderboard order due to RPC race | L | L | Cache headers + indexer hint = single ordered source. RPC inconsistency is rare. |
| 0G Galileo testnet resets | L | H | Treat as DR scenario; back up all run-log envelopes; redeploy contracts; rebuild lock files |

---

## 13. Migration from v0.1 — what stays, what changes

### 13.1 What stays

- `Agent` abstract class — no change. Existing `decide()` works.
- `BacktestEngine` — no change. Static path still ships.
- `AgentCertificate` contract — no change.
- `ZeroArenaINFT` contract — no change.
- `ReencryptionOracle` — no change.
- `@zero-arena/contracts` ABIs — additive only.
- `zeroarena` npm package public API — additive only.

### 13.2 What changes (additively)

- `ZeroArena` facade gets `startPaperRun()` / `stopPaperRun()` / `getPaperRun()`.
- New `PaperEngine` class in `src/backtest/paper.ts`.
- New streaming indicators (`StreamingRSI`, `StreamingEMA`, `StreamingMACD`) with CI tests asserting byte-equality vs batch versions.
- New backend service `zero-arena-bacend/src/paper/` (daemon, snapshot persistence, epoch batcher).
- New contract `LiveCertificate` + `Season`, deployed alongside existing three.
- New FE routes `/season` + `/season/[id]` + `/agent/[slug]/live`.
- New `lib/chain/live.ts` reader in FE.

### 13.3 What never changes

- Trust tier values: T1 = 1, T2 = 2, T3 = 3 (T2.5 reuses 2 with an `attestationHash != 0x0` flag for v0.4 only)
- Determinism rules from CLAUDE.md 7
- Encryption envelope format (`0x5A 0x01 0x01 ...`)
- `runHash` composition: `keccak(agentHash || datasetHash || optionsHash || tradesHash)`

---

## 14. Walkthroughs

### 14.1 Developer journey

```
Day 1   Developer runs:
          npx zeroarena init my-agent
          edits agent.ts, runs npm start
          → mints iNFT #50 with backtest cert that scored +1.2% on
            BTCUSDT-15m-spot historical window

Day 2   Same developer:
          npx zeroarena paper-start 50
          → Calls LiveCertificate.start(50, R₀)
          → Operator daemon spins up paper engine process for tokenId 50
          → WebSocket subscribed to BTCUSDT@kline_15m
          → Snapshot file persisted at ~/.zeroarena/snapshots/50.bin

Day 2-32 Background:
          Every 15m: paper engine receives candle close, calls decide(),
                     updates portfolio, snapshots to disk
          Every 24h: operator commits one epoch to LiveCertificate.update(50, ...)

Day 32  Developer reviews live track record:
          Opens /agent/cert-1/live
          Sees 31 epochs committed, cumulative return +4.7%, live Sharpe 1.8
          Decides to keep running

Day 60  Season 1 ends:
          Developer's agent ranked #4
          settle() pays prize to top-3 (developer doesn't win this time)
          Agent still keeps running paper, eligible for next season
```

### 14.2 Verifier journey

```
Verifier lands on https://zero-arena.vercel.app/season/1
  → Sees Season 1 live, day 12 of 30
  → Top 3 agents listed with live ROI

Click #1 agent → /agent/cert-142/live
  → Sees:
    • Static cert: runHash, datasetHash, on-chain submitted 2026-05-08
    • Live track record: 12 epochs committed, latest 2 hours ago
    • Equity curve climbing from $10k → $14.3k over 12 days
    • "Verify on chain" → Galileo Explorer link

Verifier opens chainscan-galileo:
  → Sees LiveCertificate.runs(142) returns cumulativeHash 0x...
  → Sees 12 EpochCommitted events between block X and block Y
  → For each event, can pull the encrypted envelope from 0G Storage
  → Without the AES key the envelope is opaque, but the hash chain
    verifies (replay keccak(H_{i-1} || epochHash_i) for each)

Verifier optionally asks the agent owner for the AES key (T2.5 → T2):
  → Decrypts each epoch envelope
  → Sees full trade list + per-bar equity
  → Reconstructs the running indicator state
  → Confirms each bar's agent.decide() output matches the envelope's trades
```

---

## 15. Effort estimate

| Workstream | Effort | Owner | Dependencies |
| - | - | - | - |
| SDK: `PaperEngine` + streaming indicators + tests | 1 week | SDK | None |
| SDK: snapshot/resume + CI scenario | 3 days | SDK | PaperEngine |
| Backend: paper engine daemon + WS ingestion | 1 week | BE | SDK PaperEngine |
| Backend: epoch commit batcher | 3 days | BE | LiveCertificate deployed |
| Backend: snapshot persistence + monitoring | 3 days | BE | Daemon |
| Contracts: `LiveCertificate` + tests | 4 days | Contracts | None |
| Contracts: `Season` + tests | 4 days | Contracts | LiveCertificate |
| Contracts: deploy + verify on Galileo | 1 day | Contracts | Both contracts |
| FE: `/season` + `/season/[id]` pages | 1 week | FE | Contracts deployed |
| FE: `LiveTicker` + Zustand store | 3 days | FE | Contracts deployed |
| FE: `/agent/[slug]/live` page | 3 days | FE | Contracts deployed |
| FE: chart overlay watch mode | 3 days | FE | LiveTicker |
| Docs: developer onboarding for paper mode | 2 days | All | API stable |
| QA: 7-day end-to-end run on Galileo with mock agents | 7 days (wall) | All | Everything |
| **Total** | **~7 wks (small team)** | | |

Comfortable for a 2-engineer team over 8 weeks with 1 week buffer.

---

## 16. Open questions

These don't block writing the spec, but pin them down before implementation:

1. **Epoch cadence — 24h or 8h?** 8h aligns with Binance funding settlement boundaries, makes funding-rate accounting cleaner for perp seasons. 24h saves ~3× gas. Lean: 8h.
2. **Should `Season` enforce that all enrolled iNFTs use the same `optionsHash`?** Currently the protocol allows two siblings with different `feeBps` to enroll in the same season — that's not fair. Mitigation: `Season.enroll` reads the iNFT's certificate, asserts options match the season spec. Adds 1 SLOAD.
3. **What's the recourse for an agent that gets liquidated mid-season?** Currently the run stops, ranking shows "LIQ". Should liquidated agents lose enrollment fee? Or get a courtesy zero score? Lean: zero score; no fee refund.
4. **Public profile registry for owner display names** (CLAUDE.md 16 follow-up). The leaderboard shows `Agent #142 by 0xB1a5…0DbD` which is ugly. A separate `DeveloperRegistry` contract with `setDisplayName(string)` solves this without touching encrypted metadata.
5. **Indexer hosting cost.** When traffic grows beyond what direct RPC reads can handle, we need an indexer. Goldsky? Self-hosted? Lean: stub a tiny Cloudflare Workers + Postgres service when we cross 50 active paper runs.
6. **Can agents pay for their own paper run?** v0.3 baseline = operator pays. Long-term, agent owners could fund a tip jar to subsidize their paper run gas. v0.4 territory.

---

## 17. References

- [CLAUDE.md](../CLAUDE.md) — Zero Arena build spec (especially sections 3, 7, 14, 16)
- [FORMULAS.md](../src/backtest/FORMULAS.md) — Engine math + determinism guarantees
- [nof1.ai](https://nof1.ai) — Live LLM trading benchmark; conceptual precedent for the "live arena" framing
- [0G Storage SDK docs](https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk)
- [0G Compute Network — Sealed Inference](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/inference) — TEE substrate for v0.4
- [ERC-7857 iNFT specification](https://docs.0g.ai/developer-hub/building-on-0g/inft/erc7857)
- [Binance WebSocket Stream — Kline](https://binance-docs.github.io/apidocs/spot/en/#kline-candlestick-streams)
- [Binance Futures Funding Rate](https://www.binance.com/en/support/faq/introduction-to-binance-futures-funding-rates-360033525031)

---

## 18. Appendix — design alternatives considered + rejected

### A. Why not just "live trading with paper-mode flag"?

Treating paper as "live with custody disabled" feels parsimonious but conflates two different trust models. Paper requires the operator to be honest about *ordering*; live requires the *exchange* to be honest about fills. Different attack surfaces; folding them into one engine multiplies the test matrix without simplifying anything.

### B. Why not commit every bar (no batching)?

96 tx/day per agent at 50k gas each = ~5M gas/day = expensive at any non-zero gas price. The leaderboard latency improvement (24h → 15m) doesn't justify it. Daily commit + per-bar in-memory accounting is the right ratio. Per-bar commits can be a paid upgrade later.

### C. Why not use a separate L2 for paper-run commits?

0G Chain Galileo is cheap enough that the cost argument doesn't bite. Adding a second chain doubles operator complexity (gas tokens to manage on two chains, separate RPC SLAs, bridge for prize payouts). The L2 win — finality speed — doesn't matter for daily-cadence commits.

### D. Why not anchor only at season-end?

Single-shot anchoring at season-end gives the operator the entire season to manipulate the cumulative hash before the commit, which defeats the point of the arena. Incremental anchoring with strictly-monotonic `epochIndex` prevents this.

### E. Why not Merkle proofs for individual epoch lookups?

We considered storing only the Merkle root in `LiveCertificate` and requiring verifiers to provide Merkle proofs of individual epochs. Decided against: events already give us per-epoch indexing for free, storage cost is negligible, and the proof verification adds client-side complexity for marginal benefit.

### F. Why not let the FE write to chain (mint via Connect Wallet)?

Out of scope for this RFC — CLAUDE.md 16 keeps the FE read-only at v0.1. Wallet-write flows for paper-run start/stop are a v0.4 polish step. The current `/agent/[slug]` page can have a "Start paper run" button that deep-links to a CLI command instead of executing in-browser.

### G. Why not use Optimistic / fraud-proof style?

Could let anyone submit an epoch and challenge it within a window. Overkill at v0.3 scale, adds latency, doesn't materially improve trust over the operator-signed model. Save for v1.0 if we ever need many independent operators.

---

> *This RFC is a living document until v0.3 ships. Comment via PR on `zero-arena-sdk` or open an issue tagged `rfc-001`.*
