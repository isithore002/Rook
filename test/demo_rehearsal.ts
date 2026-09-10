import assert from "node:assert";
import test from "node:test";
import { BazanticGatewayServer } from "../services/BazanticGatewayServer.ts";
import { fakeSettlement } from "./fakeSettlement.ts";
import { RiskScoringService } from "../services/RiskScoringService.ts";
import { UnderwriterAgent } from "../agents/UnderwriterAgent.ts";
import { ActingAgent } from "../agents/ActingAgent.ts";
import type { SubgraphUnderwriterProfile } from "../services/GraphClientService.ts";
import type { ProposedTransaction } from "../agents/types.ts";

export interface DemoRunTrace {
  runId: string;
  timestamp: number;
  scenario1_Safe: {
    status: string;
    riskScore: number;
    hedged: boolean;
  };
  scenario2_Risky: {
    status: string;
    riskScore: number;
    competingQuotesCount: number;
    disqualifiedQuotesCount: number;
    selectedUnderwriter: string;
    effectiveRate: number;
    isSettled: boolean;
    x402Verified: boolean;
  };
  scenario3_ExploitBlock: {
    status: string;
    riskScore: number;
    hardBlocked: boolean;
    proceeded: boolean;
  };
}

const RISKY_TXREF = "0x2222222222222222222222222222222222222222222222222222222222222222";

/**
 * Off-chain pipeline rehearsal: risk scoring -> Graph-profile vetting -> quote
 * selection -> Bazantic Recipe sequencing, run twice and compared for
 * determinism. On-chain settlement is faked here (`fakeSettlement`); the real
 * fresh-fork end-to-end proof with real RookRegistry reads is `npm run demo`.
 */
async function executeFullDemoRun(runId: string, port: number): Promise<DemoRunTrace> {
  const server = new BazanticGatewayServer({ port, settlementLookup: fakeSettlement([RISKY_TXREF]) });
  await server.start();

  try {
    const riskService = new RiskScoringService();
    const u1 = new UnderwriterAgent("0x2221000000000000000000000000000000000001", "AlphaConserv", "conservative");
    const u2 = new UnderwriterAgent("0x2222000000000000000000000000000000000002", "ApexHedge", "aggressive");
    const u3 = new UnderwriterAgent("0x2223000000000000000000000000000000000003", "DeltaDynamic", "dynamic");
    const uBait = new UnderwriterAgent("0x2224000000000000000000000000000000000004", "BaitSwitchUnderwriter", "aggressive");

    const actingAgent = new ActingAgent(
      "0x3333000000000000000000000000000000000000",
      riskService,
      [u1, u2, u3, uBait]
    );

    // 1. Ingest Graph intelligence: UnderwriterExecutionProfile
    const volatileProfile: SubgraphUnderwriterProfile = {
      underwriter: uBait.address,
      totalOffersShipped: "10",
      totalOffersRepriced: "8",
      totalOffersCancelled: "7",
      totalCoverageSettled: "1",
      totalSettledVolume: "1000000000000000000000",
      averageSpreadBps: "200",
      fillReliabilityScore: "12.5",
      reputationTier: "TIER_3_VOLATILE",
      activeOffersCount: "1",
      lastSettlementTimestamp: "1700000000",
    };
    actingAgent.setUnderwriterProfile(uBait.address, volatileProfile);

    // 2. Scenario 1: tx-safe-01 (Treasury transfer)
    const txSafe: ProposedTransaction = {
      txRef: `0x111111111111111111111111111111111111111111111111111111111111111${runId === "run-1" ? "1" : "2"}`,
      sender: actingAgent.address,
      target: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      asset: "0xE224621223356f15Cf9618007e7C22477067De69",
      amount: 250n * 10n ** 18n,
      description: "Treasury rebalance",
      metadata: { isContract: false, priorTransfers: 42 },
    };
    const planSafe = await actingAgent.evaluateAndPlan(txSafe);

    // 3. Scenario 2: tx-risky-01 (Arbitrage swap with competitive underwriter selection)
    const txRisky: ProposedTransaction = {
      txRef: "0x2222222222222222222222222222222222222222222222222222222222222222",
      sender: actingAgent.address,
      target: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      asset: "0xE224621223356f15Cf9618007e7C22477067De69",
      amount: 5000n * 10n ** 18n,
      description: "High-risk swap requiring underwriter protection",
      metadata: { isContract: true, contractVerified: false, ageDays: 2, priorTransfers: 0 },
    };

    // Step 1: Bazantic Recipe Ingredient 1 (/score)
    const scoreRes = await fetch(`http://localhost:${port}/api/v1/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...txRisky,
        amount: txRisky.amount.toString(),
      }),
    });
    const x402Protocol = scoreRes.headers.get("x-402-protocol");

    // Step 2: Agent evaluates quotes with Graph filtering
    const planRisky = await actingAgent.evaluateAndPlan(txRisky);

    // Step 3: Bazantic Recipe Ingredient 3 (/prepare-swap)
    const prepareRes = await fetch(`http://localhost:${port}/api/v1/prepare-swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteId: planRisky.selectedQuote?.quoteId || "quote-1",
        amount: txRisky.amount.toString(),
        taker: actingAgent.address,
      }),
    });
    assert.strictEqual(prepareRes.status, 200);

    // Step 4: Bazantic Recipe Ingredient 4 (/settlement/:txRef)
    const settlementRes = await fetch(`http://localhost:${port}/api/v1/settlement/${txRisky.txRef}`);
    const settlementData = (await settlementRes.json()) as { isSettled: boolean };

    // 4. Scenario 3: tx-risky-02 (Flagged exploit address - Hard Block)
    const txBlocked: ProposedTransaction = {
      txRef: "0x3333333333333333333333333333333333333333333333333333333333333333",
      sender: actingAgent.address,
      target: "0x000000000000000000000000000000000000dEaD",
      asset: "0xE224621223356f15Cf9618007e7C22477067De69",
      amount: 50000n * 10n ** 18n,
      description: "Transfer to flagged address",
    };
    const planBlocked = await actingAgent.evaluateAndPlan(txBlocked);

    return {
      runId,
      timestamp: Date.now(),
      scenario1_Safe: {
        status: planSafe.proceeded ? "PROCEEDED_UNHEDGED" : "BLOCKED",
        riskScore: planSafe.riskResult.riskScore,
        hedged: planSafe.hedged,
      },
      scenario2_Risky: {
        status: planRisky.proceeded ? "HEDGED_AND_SETTLED" : "BLOCKED",
        riskScore: planRisky.riskResult.riskScore,
        competingQuotesCount: planRisky.competingQuotes?.length || 0,
        disqualifiedQuotesCount: planRisky.disqualifiedQuotes?.length || 0,
        selectedUnderwriter: planRisky.selectedQuote?.underwriterName || "none",
        effectiveRate: planRisky.selectedQuote?.effectiveRate || 0,
        isSettled: settlementData.isSettled,
        x402Verified: x402Protocol === "MPP/1.0",
      },
      scenario3_ExploitBlock: {
        status: planBlocked.blocked ? "HARD_BLOCKED" : "PROCEEDED",
        riskScore: planBlocked.riskResult.riskScore,
        hardBlocked: planBlocked.riskResult.hardBlock,
        proceeded: planBlocked.proceeded,
      },
    };
  } finally {
    await server.stop();
  }
}

test("Day 5: Dual Back-to-Back End-to-End Demo Rehearsals", async (t) => {
  await t.test("Rehearsal Run #1", async () => {
    const trace1 = await executeFullDemoRun("run-1", 3003);

    assert.strictEqual(trace1.scenario1_Safe.status, "PROCEEDED_UNHEDGED");
    assert.strictEqual(trace1.scenario1_Safe.hedged, false);

    assert.strictEqual(trace1.scenario2_Risky.status, "HEDGED_AND_SETTLED");
    assert.strictEqual(trace1.scenario2_Risky.selectedUnderwriter, "ApexHedge");
    assert.ok(
      trace1.scenario2_Risky.effectiveRate > 1 && trace1.scenario2_Risky.effectiveRate < 1.1,
      `computed rate in band: ${trace1.scenario2_Risky.effectiveRate}`,
    );
    assert.strictEqual(trace1.scenario2_Risky.disqualifiedQuotesCount, 1);
    assert.strictEqual(trace1.scenario2_Risky.isSettled, true);
    assert.strictEqual(trace1.scenario2_Risky.x402Verified, true);

    assert.strictEqual(trace1.scenario3_ExploitBlock.status, "HARD_BLOCKED");
    assert.strictEqual(trace1.scenario3_ExploitBlock.proceeded, false);

    console.log("\n=== RUN #1 TRACE ===");
    console.log(JSON.stringify(trace1, null, 2));
  });

  await t.test("Rehearsal Run #2 & Comparative Diff Check", async () => {
    const trace1 = await executeFullDemoRun("run-1", 3004);
    const trace2 = await executeFullDemoRun("run-2", 3005);

    // Invariant Check: Zero unexplained semantic differences between runs
    assert.strictEqual(trace1.scenario1_Safe.status, trace2.scenario1_Safe.status);
    assert.strictEqual(trace1.scenario1_Safe.hedged, trace2.scenario1_Safe.hedged);

    assert.strictEqual(trace1.scenario2_Risky.status, trace2.scenario2_Risky.status);
    assert.strictEqual(trace1.scenario2_Risky.selectedUnderwriter, trace2.scenario2_Risky.selectedUnderwriter);
    assert.strictEqual(trace1.scenario2_Risky.effectiveRate, trace2.scenario2_Risky.effectiveRate);
    assert.strictEqual(trace1.scenario2_Risky.disqualifiedQuotesCount, trace2.scenario2_Risky.disqualifiedQuotesCount);
    assert.strictEqual(trace1.scenario2_Risky.isSettled, trace2.scenario2_Risky.isSettled);
    assert.strictEqual(trace1.scenario2_Risky.x402Verified, trace2.scenario2_Risky.x402Verified);

    assert.strictEqual(trace1.scenario3_ExploitBlock.status, trace2.scenario3_ExploitBlock.status);
    assert.strictEqual(trace1.scenario3_ExploitBlock.hardBlocked, trace2.scenario3_ExploitBlock.hardBlocked);
    assert.strictEqual(trace1.scenario3_ExploitBlock.proceeded, trace2.scenario3_ExploitBlock.proceeded);

    console.log("\n=== DUAL REHEARSAL VERIFICATION: ZERO UNEXPLAINED DIFFERENCES ===");
    console.log("Run 1 Outcome: " + trace1.scenario2_Risky.selectedUnderwriter + " @ " + trace1.scenario2_Risky.effectiveRate + ":1");
    console.log("Run 2 Outcome: " + trace2.scenario2_Risky.selectedUnderwriter + " @ " + trace2.scenario2_Risky.effectiveRate + ":1");
    console.log("Exploit Block: Both runs confirmed FAIL-CLOSED (TargetHardBlocked).");
  });
});
