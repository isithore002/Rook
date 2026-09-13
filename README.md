# Rook: Pre-Execution Transaction Downside Hedging for Autonomous Agents

Rook is a decentralized, real-time risk underwriting protocol for autonomous agents moving on-chain value. It replaces binary allowlists and slow, off-chain insurance policies with an active, competitive market: independent underwriter agents price and provide atomic downside protection floors against risky transactions before they execute, backed by 1inch Aqua wallet-resident liquidity and executed via custom SwapVM bytecode.

---

## 1. Executive Summary & Thesis

```
                    AGENT INTENT
                         │
                         ▼
                  TRANSACTION RISK
                         │
                         ▼
              ┌─────────────────────┐
              │    THE GRAPH        │
              │                     │
              │ Underwriter         │
              │ Execution Profile   │
              └──────────┬──────────┘
                         │
                         ▼
                 COMPETING QUOTES
                         │
                         ▼
              ┌─────────────────────┐
              │    1inch AQUA       │
              │                     │
              │ Wallet liquidity    │
              │ + SwapVM 0x55       │
              └──────────┬──────────┘
                         │
                         ▼
                PROTECTED EXECUTION
                         ▲
                         │
              ┌──────────┴──────────┐
              │     BAZANTIC        │
              │                     │
              │ Recipe + Gateway    │
              │ + machine payment   │
              └─────────────────────┘
```

Rook combines **transaction-level risk assessment**, **competitive underwriter liquidity**, **Aqua-based conditional settlement**, **Graph-derived underwriter intelligence**, and a **machine-consumable Bazantic Recipe** into one cohesive execution flow.

---

## 2. The Problem: Headless Capital in Adversarial Environments

Autonomous AI agents are increasingly entrusted with treasury management, DEX arbitrage, and cross-chain rebalancing. However, they face a fatal structural hazard:
1. **Zero Legal Identity**: Headless software agents have no legal standing, corporate charter, or credit score. Traditional insurers (and even Lloyd's syndicates) cannot underwrite them in real time (as highlighted by a16z crypto's 2026 infrastructure thesis).
2. **Binary Risk Defenses**: Current defense mechanisms are crude—either a binary transaction allowlist (which cripples autonomous alpha) or post-exploit committee arbitration (which takes weeks).
3. **Execution-Time Toxic Exposures**: When an agent interacts with an unverified contract or complex arbitrage path, unexpected slippage, sandwich attacks, or drainer contracts can permanently wipe out the agent's capital.

Rook solves this by creating a **real-time, pre-execution downside hedging market** where independent underwriter agents quote conditional floor prices, settled atomically on-chain.

---

## 3. Structural Differentiation & Prior Art (NOVELTY_CHECK.md)

Rook's novelty is anchored in a specific, verified triple:
**(a) multiple competing underwriter agents**,
**(b) real-time per-transaction pricing**, and
**(c) atomic on-chain settlement of the downside hedge itself.**

Each element in isolation has prior art; their combination does not.

### Real-World Benchmark: AIUC
- **AIUC (Nat Friedman-backed, Lloyd's bound $50M policy for ElevenLabs)**: Provides AI agent insurance via the AIUC-1 certification framework.
- **Why Rook is Structurally Different**: AIUC operates an annual, certification-based, off-chain enterprise policy priced once per audit cycle and settled through traditional legal/claims channels. Rook is **real-time, per-transaction, on-chain, and settled atomically** via a competitive market of autonomous underwriters. For AIUC to replicate Rook, they would have to discard their annual underwriting framework and rebuild around continuous, trustless on-chain settlement.

### Hackathon-Adjacent Prior Art
- **AgentH (Hedera)**: A single insurance-quoting agent for travel insurance. *Difference: Non-competitive (single agent, single quote), static domain.*
- **On-chain Trust Layer for Agents (Uniswap)**: Permission and guardrail bounds on private keys. *Difference: Does not do risk pricing or underwriting.*
- **AI DeFi Attack Cascade Detector**: Detects attacks and triggers exit. *Difference: Reactive risk mitigation/exit, not continuous underwriter risk pricing or hedging.*
- **Dark Pool for Autonomous Agents**: Private quoting with atomic on-chain settlement. *Difference: Quoting and settlement for trade liquidity/execution, not risk protection or downside floor underwriting.*

### External Validation
In April 2026, **a16z crypto** identified transaction underwriting as one of five fundamental missing primitives for the emerging AI agent economy, specifically framing it as a blockchain-native problem because traditional finance cannot underwrite headless software agents in real-time.

---

## 4. Why AI? Why Blockchain?

### Why AI?
- **High-Dimensional Risk Context**: Transaction risk cannot be captured by static heuristics alone. Evaluating contract age, simulation traces, and call-depth anomalies requires heuristic scoring backed by advisory LLM analysis.
- **Autonomous Underwriting Personas**: Different underwriter agents maintain distinct risk appetites, pricing curves (e.g. `AlphaConserv` vs `ApexHedge` vs `DeltaDynamic`), and inventory capacities, responding dynamically to shifting market volatility.

### Why Blockchain?
- **Atomicity & Fail-Closed Guarantees**: Off-chain promises cannot guarantee that a hedge executes if and only if a transaction occurs. `AgentHedgeExecutor.sol` guarantees that if a hedge fails or underwriter liquidity is insufficient, the risky transaction reverts—impossible in Web2.
- **Self-Custodial Capital Efficiency**: 1inch Aqua enables underwriters to deploy capital from their own wallets across multiple positions without tying funds up in single-use pools.

---

## 5. The Core Mechanism: Hedging vs. Insurance

Rook provides **atomic pre-execution downside hedging**, NOT claims-based insurance:

| Dimension | Traditional On-Chain Insurance (e.g. Nexus Mutual) | Rook Transaction Hedging |
|---|---|---|
| **Settlement Timing** | Days / weeks after an exploit occurs | **Pre-execution / Atomic on-chain swap** |
| **Payout Trigger** | Subjective claims committee or oracle arbitration | **Deterministic EVM swap fill** |
| **Capital Architecture** | Shared mutual pools locking protocol capital | **Self-custodial, wallet-resident Aqua liquidity** |
| **Agent Suitability** | Incompatible with autonomous, headless AI agents | **Machine-payable (x402) and fully autonomous** |

### Two Economic Execution Models (Supported by `AgentHedgeExecutor.sol`)

1. **Model A (Inventory Pre-Hedge — `executeProtected`)**:
   The agent already holds an exposure of volatile token inventory. It swaps into safe stable collateral at an agreed underwriter rate prior to triggering an unverified counterparty interaction.
2. **Model B (Atomic Conditional Downside Exit Floor — `executeProtectedExit`)**:
   The underwriter pre-commits a guaranteed swap floor (e.g. 0.95 USDC per Token X) via SwapVM opcode `0x55`. The agent executes the risky target call to acquire Token X, and within the **exact same atomic transaction block**, immediately exercises the underwriter's SwapVM floor. If the floor fails or the underwriter lacks liquidity, the entire transaction reverts, ensuring the agent **never ends up holding unhedged toxic inventory**.

---

## 6. Tri-Sponsor Division of Responsibilities & Removal Tests

Each sponsor owns a strictly non-overlapping, load-bearing capability that passes the **Sponsor Removal Test**:

### 1. The Graph — "KNOW THE STATE"
- **Derived Underwriter Execution Profiles**: Indexes the complete lifecycle of `RevocableRateOffer` (`OfferCreated`, `OfferRepriced`, `OfferRevoked`, `CoverageSettled`).
- **Intelligence Beyond Aggregation**: Synthesizes `fillReliabilityScore` ($\frac{\text{settled}}{\text{settled} + \text{cancelled}} \times 100$), spread volatility, and reputation tiering (`TIER_1_PRIME`, `TIER_2_STANDARD`, `TIER_3_VOLATILE`).
- **Autonomous Agent Consumption**: The Acting Agent consumes GraphQL profiles to immediately disqualify volatile or bait-and-switch underwriters before evaluating quotes.
- **The Graph Removal Test**: *If The Graph is removed, the agent loses derived historical fill reliability metrics and falls victim to bait-and-switch quote traps that cannot be detected by raw RPC polling.*

### 2. Bazantic — "OPERATE THE CAPABILITY"
- **`SecureTransactionHedgeRecipe`**: Packages 4 cross-boundary services (`scoreTransactionRisk` $\rightarrow$ `discoverHedgeQuotes` $\rightarrow$ `prepareHedgeSwap` $\rightarrow$ `verifySettlementProof`) into an agent-discoverable, executable workflow.
- **x402/MPP Machine Payments**: Monitored and monetized per-request for autonomous agents.
- **Verified Benchmark**: Proves a 100% completion success rate for Recipe-guided agents vs. 0% completion (sequencing errors) for unguided agents.
- **Bazantic Removal Test**: *If Bazantic is removed, Rook degrades into an isolated private script. With Bazantic, any external autonomous agent can discover, sequence, and machine-pay for pre-execution downside protection.*

### 3. 1inch Aqua — "SETTLE THE RISK"
- **Self-Custodial Liquidity**: Underwriters back quotes directly from their own wallet balances without locking capital into single-use escrows.
- **Custom SwapVM Opcode `0x55` (`RevocableRateOffer`)**: Transforms SwapVM into a stateful, revocable order engine tracking cumulative fills against `maxSize` with on-chain repricing and zero-gas cancellation.
- **Fail-Closed Guarantee**: Enforced by `AgentHedgeExecutor.sol`—if a hedge cannot be established or filled, the risky target transaction is strictly prevented from executing.
- **1inch Aqua Removal Test**: *If Aqua is removed, underwriters must lock 100% collateral into discrete smart contracts for every quote, destroying capital efficiency and rendering atomic pre-execution conditional fills impossible.*

---

## 7. The 10 Security & Economic Invariants

**Evidence state (see `CLAUDE.md` §1).** **FORK-VERIFIED** rows execute against a
freshly-spawned Anvil node from clean process state via `npm run demo`, with
real transaction hashes and on-chain state re-read independently — not Foundry's
in-process EVM. **TESTED** rows (failure-path / adversarial cases not exercised
by the live happy-path demo) are proven by `VerifyDay4Fork.t.sol` against the
real contracts inside Foundry's EVM.

| # | Invariant | Verification | Status |
|---|---|---|---|
| **1** | Accepted offer terms cannot change during fill | `npm run demo` (real ship → real fill, same encoded order) | **FORK-VERIFIED** 🟢 |
| **2** | Revocation / repricing authority belongs strictly to maker | `VerifyDay4Fork.t.sol::test_Day4_Invariant2_MakerAuthorityOnly` | TESTED 🟡 |
| **3** | `filledAmount` can never exceed `maxSize` | `VerifyDay4Fork.t.sol::test_Day4_Invariant3_CapacityEnforced` | TESTED 🟡 |
| **4** | Expired / revoked offers revert deterministically | `VerifyDay4Fork.t.sol::test_Day4_Invariant4_ExpiredOrRevokedOffersRevert` | TESTED 🟡 |
| **5** | Insufficient Aqua liquidity reverts | `VerifyDay4Fork.t.sol::test_Day4_Invariant5_InsufficientAquaLiquidityReverts` | TESTED 🟡 |
| **6** | **Failed hedge CANNOT fall through into unhedged execution** | `VerifyDay4Fork.t.sol::test_Day4_Invariant6_FailedHedgeCannotFallThrough` (failure path); success path is `npm run demo` | FORK-VERIFIED (success) / TESTED (failure) 🟢🟡 |
| **7** | Graph-derived reputation disqualifies unreliable underwriters | `npm run demo`: `services/RookIndexer.ts` replays real `OfferRevoked` events and derives `TIER_3_VOLATILE` from them — the Acting Agent disqualifies on that real history | **FORK-VERIFIED** 🟢 |
| **8** | Bazantic Recipe executes the full multi-step workflow | `npm run demo`: `/score` and `/settlement` run against the real risk service and real `RookRegistry`; `/prepare-swap` remains a canned response | TESTED 🟡 |
| **9** | Successful settlement produces verifiable on-chain state | `npm run demo`: real `CoverageSettled`, real tx hash, `registry.getCoverage` re-read independently | **FORK-VERIFIED** 🟢 |
| **10**| `tx-risky-02` demonstrably fails closed | `npm run demo`: `HARD_BLOCKED`, zero ships/fills on the live node, real exploit-target pre-block | **FORK-VERIFIED** 🟢 |

**Security hardening (beyond the 10 invariants):** `RookRegistry.recordCoverage`
is restricted to an `onlyRecorder`-authorized caller (only the deployed
`AgentHedgeExecutor` by default) — earlier it was callable by anyone, making the
audit trail forgeable. `AgentHedgeExecutor`'s block-list setters are
`onlyOwner` — earlier anyone could unblock the exploit target, defeating
Invariant 10. Both fixed with dedicated tests; see `HANDOFF.md` P2.10/P2.11.

---

## 8. Live, Reproducible, End-to-End (`npm run demo`)

Two fully independent runs — fresh Anvil, fresh deploy, fresh process state each
time — compared field-by-field with `assert.deepStrictEqual`. They come back
**byte-identical**, including the settlement transaction hash:

```json
{
  "scenarios": [
    { "label": "tx-safe-01",  "outcome": "PROCEEDED_UNHEDGED" },
    { "label": "tx-risky-01", "outcome": "HEDGED_AND_SETTLED",
      "quoted": ["AlphaConserv 1.0854", "ApexHedge 1.044 (winner)", "DeltaDynamic 1.1089"],
      "disqualified": ["DeltaDynamic — TIER_3_VOLATILE, reliability 0.0 (3 real on-chain revokes, 0 settlements)"],
      "marketEvents": ["AlphaConserv repriced 1.25:1 -> 1.28:1", "DeltaDynamic cancelled its offer"],
      "execution": { "coverageRecorded": true, "safeAmountOut": "5000e18" } },
    { "label": "tx-risky-02", "outcome": "HARD_BLOCKED" }
  ],
  "gateway": { "x402Protocol": "MPP/1.0", "settlement": { "isSettled": true } }
}
```

Underwriter rates are *computed*, not fixed constants: `spreadBps = base +
kRisk·riskScore + kInv·fillFraction²` per strategy, so a different ticket size
picks a different winner (see `test/agents.test.ts`, "a large fill flips the
winner to the conservative book"). The Graph role is real: `RookIndexer`
replays on-chain `Shipped`/`OfferRepriced`/`OfferRevoked`/`CoverageSettled` logs
into the same derived-reputation shape the subgraph mapping produces, and the
disqualification above is driven by that real history, not a fixture.

---

## 9. How to Run & Verify

### Prerequisites
- Node.js v22+
- Foundry (`forge`, `anvil`)
- Contract deps (once): `cd swap-vm && yarn install` then `cd ../aqua && yarn install`.
  `swap-vm`/`aqua` resolve Solidity imports from `node_modules` (`@1inch/aqua`,
  `@openzeppelin/contracts`, `forge-std`); `yarn.lock` is committed for pinning.
  First `forge` build is slow (`via_ir = true`).

### Run Tests
```bash
# Solidity: real Aqua + SwapVM 0x55 + RookRegistry + AgentHedgeExecutor,
# executed in Foundry's EVM (no external node required).
# 28 Rook tests across 6 suites (RevocableRateOffer, RookRegistry, VerifyDay1-4).
npm run test:contracts
#   or: forge test --root swap-vm

# Off-chain pipeline: agents, risk scoring, Bazantic gateway/recipe,
# benchmark, back-to-back rehearsal. 21 tests.
npm test

# Both:
npm run test:all

# LIVE single run: fresh Anvil -> deploy -> real agents -> real SwapVM 0x55
# fills -> real RookRegistry settlement, with real transaction hashes.
npm run e2e

# LIVE, TWICE, COMPARED — the DEMO-VERIFIED gate (CLAUDE.md §1, PROMPTS.md §10):
# two independent clean-state runs, asserted byte-identical.
npm run demo
```

> Build note: this repo's canonical Foundry profile is `via_ir` +
> `optimizer_runs = 700` (`npm run test:contracts:ci`, used in CI). Locally,
> `npm run test:contracts` / `npm run e2e` / `npm run demo` use a `lowmem`
> profile (`optimizer_runs = 1`, Yul optimizer steps off) that trades gas
> optimisation for a build that fits in a few GB of RAM, and skip two upstream
> `XYCConcentrateFee*` tests that a *cold* `via_ir` compile at that setting
> reproducibly trips on (unrelated to Rook's own contracts). Because `lowmem`
> bytecode runs large, `npm run e2e` / `npm run demo` launch Anvil with
> `--disable-code-size-limit`.
