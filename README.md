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

**Evidence state (see `CLAUDE.md` §1).** Every row below has a passing automated
test. The Solidity rows execute the *real* Aqua Core + `AquaSwapVMRouter` +
custom opcode `0x55` + `RookRegistry` + `AgentHedgeExecutor` inside Foundry's
EVM — real contracts, real swaps, real on-chain state reads — which earns
**TESTED**. Promoting them to **FORK-VERIFIED** requires the same flow against a
persistent Anvil node from clean process state, capturing real transaction
hashes; that end-to-end runner is in progress and tracked in `HANDOFF.md`.

| # | Invariant | Verification Contract & Test | Status |
|---|---|---|---|
| **1** | Accepted offer terms cannot change during fill | `VerifyDay4Fork.t.sol::test_Day4_Invariant1_6_9_SuccessfulProtectedExecution` | **TESTED** 🟢 |
| **2** | Revocation / repricing authority belongs strictly to maker | `VerifyDay4Fork.t.sol::test_Day4_Invariant2_MakerAuthorityOnly` | **TESTED** 🟢 |
| **3** | `filledAmount` can never exceed `maxSize` | `VerifyDay4Fork.t.sol::test_Day4_Invariant3_CapacityEnforced` | **TESTED** 🟢 |
| **4** | Expired / revoked offers revert deterministically | `VerifyDay4Fork.t.sol::test_Day4_Invariant4_ExpiredOrRevokedOffersRevert` | **TESTED** 🟢 |
| **5** | Insufficient Aqua liquidity reverts | `VerifyDay4Fork.t.sol::test_Day4_Invariant5_InsufficientAquaLiquidityReverts` | **TESTED** 🟢 |
| **6** | **Failed hedge CANNOT fall through into unhedged execution** | `VerifyDay4Fork.t.sol::test_Day4_Invariant6_FailedHedgeCannotFallThrough` (target execution count = 0) | **TESTED** 🟢 |
| **7** | Graph reputation influences quote selection | `test/agents.test.ts` (disqualifies `TIER_3_VOLATILE` underwriters) | **TESTED** 🟢 |
| **8** | Bazantic Recipe executes full multi-step workflow | `test/bazantic_benchmark.test.ts` (100% Recipe completion vs. 0% unguided) | **TESTED** 🟢 |
| **9** | Successful settlement produces verifiable on-chain state | `VerifyDay4Fork.t.sol` (`CoverageSettled` on `RookRegistry`) | **TESTED** 🟢 |
| **10**| `tx-risky-02` demonstrably fails closed | `VerifyDay4Fork.t.sol::test_Day4_Invariant10_TxRisky02_FailsClosed` | **TESTED** 🟢 |

---

## 8. Back-to-Back Demo Rehearsal Results

Executed via `test/demo_rehearsal.ts` as two back-to-back runs of the **off-chain
pipeline** (risk scoring → Graph-profile vetting → quote selection → Bazantic
Recipe sequencing). At this layer the Aqua fill and `RookRegistry` settlement are
represented by the gateway, not executed on a node; the live-node end-to-end
runner that drives real swaps and asserts on real `CoverageSettled` logs is in
progress (`HANDOFF.md`). Both runs are byte-identical:

```json
{
  "rehearsal_run_1": {
    "tx-safe-01": "PROCEEDED_UNHEDGED",
    "tx-risky-01": "HEDGED_AND_SETTLED (ApexHedge @ 1.05:1, BaitSwitchUnderwriter disqualified via Graph profile)",
    "tx-risky-02": "HARD_BLOCKED (TargetHardBlocked, 0 funds lost)"
  },
  "rehearsal_run_2": {
    "tx-safe-01": "PROCEEDED_UNHEDGED",
    "tx-risky-01": "HEDGED_AND_SETTLED (ApexHedge @ 1.05:1, BaitSwitchUnderwriter disqualified via Graph profile)",
    "tx-risky-02": "HARD_BLOCKED (TargetHardBlocked, 0 funds lost)"
  },
  "comparative_audit": "Zero unexplained semantic differences across runs."
}
```

---

## 9. How to Run & Verify

### Prerequisites
- Node.js v22+
- Foundry (`forge`, `anvil`)

### Run Tests
```bash
# Solidity: real Aqua + SwapVM 0x55 + RookRegistry + AgentHedgeExecutor,
# executed in Foundry's EVM (no external node required).
# 26 Rook tests across 6 suites (RevocableRateOffer, RookRegistry, VerifyDay1-4).
npm run test:contracts
#   or: forge test --root swap-vm

# Off-chain pipeline: agents, risk scoring, Bazantic gateway/recipe,
# benchmark, back-to-back rehearsal. 20 tests.
npm test

# Both:
npm run test:all
```
