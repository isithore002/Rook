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

## 2. The Core Mechanism: Hedging vs. Insurance

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

## 3. Tri-Sponsor Division of Responsibilities

Each sponsor owns a strictly non-overlapping, load-bearing capability:

### 1. The Graph — "KNOW THE STATE"
- **Derived Underwriter Execution Profiles**: Indexes the complete lifecycle of `RevocableRateOffer` (`OfferCreated`, `OfferRepriced`, `OfferRevoked`, `CoverageSettled`).
- **Intelligence Beyond Aggregation**: Synthesizes `fillReliabilityScore` ($\frac{\text{settled}}{\text{settled} + \text{cancelled}} \times 100$), spread volatility, and reputation tiering (`TIER_1_PRIME`, `TIER_2_STANDARD`, `TIER_3_VOLATILE`).
- **Autonomous Agent Consumption**: The Acting Agent consumes GraphQL profiles to immediately disqualify volatile or bait-and-switch underwriters before evaluating quotes.

### 2. Bazantic — "OPERATE THE CAPABILITY"
- **`SecureTransactionHedgeRecipe`**: Packages 4 cross-boundary services (`scoreTransactionRisk` $\rightarrow$ `discoverHedgeQuotes` $\rightarrow$ `prepareHedgeSwap` $\rightarrow$ `verifySettlementProof`) into an agent-discoverable, executable workflow.
- **x402/MPP Machine Payments**: Monitored and monetized per-request for autonomous agents.
- **Verified Benchmark**: Proves a 100% completion success rate for Recipe-guided agents vs. 0% completion (sequencing errors) for unguided agents.

### 3. 1inch Aqua — "SETTLE THE RISK"
- **Self-Custodial Liquidity**: Underwriters back quotes directly from their own wallet balances without locking capital into single-use escrows.
- **Custom SwapVM Opcode `0x55` (`RevocableRateOffer`)**: Transforms SwapVM into a stateful, revocable order engine tracking cumulative fills against `maxSize` with on-chain repricing and zero-gas cancellation.
- **Fail-Closed Guarantee**: Enforced by `AgentHedgeExecutor.sol`—if a hedge cannot be established or filled, the risky target transaction is strictly prevented from executing.

---

## 4. The 10 Verified Security & Economic Invariants

| # | Invariant | Verification Contract & Test | Status |
|---|---|---|---|
| **1** | Accepted offer terms cannot change during fill | `VerifyDay4Fork.t.sol::test_Day4_Invariant1_6_9_SuccessfulProtectedExecution` | **FORK-VERIFIED** 🟢 |
| **2** | Revocation / repricing authority belongs strictly to maker | `VerifyDay4Fork.t.sol::test_Day4_Invariant2_MakerAuthorityOnly` | **FORK-VERIFIED** 🟢 |
| **3** | `filledAmount` can never exceed `maxSize` | `VerifyDay4Fork.t.sol::test_Day4_Invariant3_CapacityEnforced` | **FORK-VERIFIED** 🟢 |
| **4** | Expired / revoked offers revert deterministically | `VerifyDay4Fork.t.sol::test_Day4_Invariant4_ExpiredOrRevokedOffersRevert` | **FORK-VERIFIED** 🟢 |
| **5** | Insufficient Aqua liquidity reverts | `VerifyDay4Fork.t.sol::test_Day4_Invariant5_InsufficientAquaLiquidityReverts` | **FORK-VERIFIED** 🟢 |
| **6** | **Failed hedge CANNOT fall through into unhedged execution** | `VerifyDay4Fork.t.sol::test_Day4_Invariant6_FailedHedgeCannotFallThrough` (target execution count = 0) | **FORK-VERIFIED** 🟢 |
| **7** | Graph reputation influences quote selection | `test/agents.test.ts` (disqualifies `TIER_3_VOLATILE` underwriters) | **TESTED** 🟢 |
| **8** | Bazantic Recipe executes full multi-step workflow | `test/bazantic_benchmark.test.ts` (100% Recipe completion vs. 0% unguided) | **TESTED** 🟢 |
| **9** | Successful settlement produces verifiable on-chain state | `VerifyDay4Fork.t.sol` (`CoverageSettled` on `RookRegistry`) | **FORK-VERIFIED** 🟢 |
| **10**| `tx-risky-02` demonstrably fails closed | `VerifyDay4Fork.t.sol::test_Day4_Invariant10_TxRisky02_FailsClosed` | **FORK-VERIFIED** 🟢 |

---

## 5. Dual Back-to-Back Demo Rehearsal Results

Executed via `test/demo_rehearsal.ts` across two independent, clean-state runs:

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

## 6. How to Run & Verify

### Prerequisites
- Node.js v22+
- Foundry (`forge`, `anvil`)

### Run Tests
```bash
# 1. Start local Anvil fork
anvil --port 8545

# 2. Run Foundry on-chain fork verification suite (8 tests)
cd swap-vm
forge test --fork-url http://127.0.0.1:8545 --match-contract VerifyDay4ForkTest -vvv

# 3. Run full TypeScript suite (16 tests, including Bazantic benchmark & dual rehearsal)
cd ..
node --experimental-strip-types --test test/agents.test.ts test/bazantic.test.ts test/bazantic_benchmark.test.ts test/demo_rehearsal.ts
```
