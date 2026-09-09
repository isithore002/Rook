import assert from "node:assert";
import test from "node:test";
import type { ProposedTransaction } from "../agents/types.ts";
import { RiskScoringService } from "../services/RiskScoringService.ts";
import { UnderwriterAgent } from "../agents/UnderwriterAgent.ts";
import { ActingAgent } from "../agents/ActingAgent.ts";
import type { SubgraphUnderwriterProfile } from "../services/GraphClientService.ts";

test("Rook Off-Chain Pipeline - RiskScoringService & Agents", async (t) => {
  const riskService = new RiskScoringService();

  const u1 = new UnderwriterAgent("0x2222000000000000000000000000000000000001", "AlphaConserv", "conservative");
  const u2 = new UnderwriterAgent("0x2222000000000000000000000000000000000002", "ApexHedge", "aggressive");
  const u3 = new UnderwriterAgent("0x2222000000000000000000000000000000000003", "DeltaDynamic", "dynamic");

  const actingAgent = new ActingAgent(
    "0x3333000000000000000000000000000000000000",
    riskService,
    [u1, u2, u3]
  );

  await t.test("Scenario: tx-safe-01 (Routine Treasury Transfer)", async () => {
    const txSafe: ProposedTransaction = {
      txRef: "0x1111111111111111111111111111111111111111111111111111111111111111",
      sender: actingAgent.address,
      target: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      asset: "0xE224621223356f15Cf9618007e7C22477067De69",
      amount: 250n * 10n ** 18n,
      description: "Routine liquidity rebalance to internal treasury",
      metadata: {
        isContract: false,
        priorTransfers: 42,
      },
    };

    const plan = await actingAgent.evaluateAndPlan(txSafe);

    assert.strictEqual(plan.proceeded, true, "Safe transaction should proceed");
    assert.strictEqual(plan.blocked, false, "Safe transaction should not be blocked");
    assert.strictEqual(plan.hedged, false, "Safe transaction should not require hedge");
    assert.strictEqual(plan.riskResult.requiresHedge, false);
    assert.ok(plan.riskResult.riskScore < 50, `Risk score should be low: ${plan.riskResult.riskScore}`);
  });

  await t.test("Scenario: tx-risky-01 (High-Value Arbitrage Transfer)", async () => {
    const txRisky: ProposedTransaction = {
      txRef: "0x2222222222222222222222222222222222222222222222222222222222222222",
      sender: actingAgent.address,
      target: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      asset: "0xE224621223356f15Cf9618007e7C22477067De69",
      amount: 5000n * 10n ** 18n,
      description: "High-value swap on newly deployed automated market maker pool",
      metadata: {
        isContract: true,
        contractVerified: false,
        ageDays: 2,
        priorTransfers: 0,
      },
    };

    const plan = await actingAgent.evaluateAndPlan(txRisky);

    assert.strictEqual(plan.proceeded, true, "Risky transaction should proceed with hedge");
    assert.strictEqual(plan.blocked, false, "Risky transaction should not be blocked");
    assert.strictEqual(plan.hedged, true, "Risky transaction must be hedged");
    assert.strictEqual(plan.riskResult.requiresHedge, true);
    assert.ok(plan.riskResult.riskScore >= 50, `Risk score should be elevated: ${plan.riskResult.riskScore}`);

    // Verify competitive quotes
    assert.ok(plan.competingQuotes, "Should have competing quotes");
    assert.strictEqual(plan.competingQuotes.length, 3, "All 3 underwriters should quote");

    // Verify best quote selection: Underwriter 2 (ApexHedge at 1.05:1)
    assert.ok(plan.selectedQuote);
    assert.strictEqual(plan.selectedQuote.underwriterName, "ApexHedge");
    assert.strictEqual(plan.selectedQuote.effectiveRate, 1.05);

    // Verify other rates
    const u1Quote = plan.competingQuotes.find((q) => q.underwriterName === "AlphaConserv");
    const u3Quote = plan.competingQuotes.find((q) => q.underwriterName === "DeltaDynamic");

    assert.ok(u1Quote);
    assert.strictEqual(u1Quote.effectiveRate, 1.25);

    assert.ok(u3Quote);
    assert.ok(u3Quote.effectiveRate > 1.05 && u3Quote.effectiveRate < 1.25);
  });

  await t.test("Scenario: tx-risky-02 (Flagged Exploit Address - Hard Block)", async () => {
    const txBlocked: ProposedTransaction = {
      txRef: "0x3333333333333333333333333333333333333333333333333333333333333333",
      sender: actingAgent.address,
      target: "0x000000000000000000000000000000000000dEaD",
      asset: "0xE224621223356f15Cf9618007e7C22477067De69",
      amount: 50000n * 10n ** 18n,
      description: "Transfer to flagged address",
    };

    const plan = await actingAgent.evaluateAndPlan(txBlocked);

    assert.strictEqual(plan.proceeded, false, "Blocked transaction must not proceed");
    assert.strictEqual(plan.blocked, true, "Transaction must be marked blocked");
    assert.strictEqual(plan.riskResult.hardBlock, true, "Must trigger hard block");
    assert.strictEqual(plan.riskResult.riskScore, 100);
  });

  await t.test("Invariant 7: Graph Intelligence Filters Out Unreliable Underwriter", async () => {
    // Underwriter 4 is a bait-and-switch underwriter quoting a cheap rate (1.02:1)
    // but The Graph tracks high cancellation history -> TIER_3_VOLATILE
    const uBait = new UnderwriterAgent("0x2222000000000000000000000000000000000004", "BaitSwitchUnderwriter", "aggressive");
    const testAgent = new ActingAgent(
      actingAgent.address,
      riskService,
      [u1, u2, uBait]
    );

    // Provide Graph Execution Profile marking uBait as volatile (high cancellations)
    const volatileProfile: SubgraphUnderwriterProfile = {
      underwriter: uBait.address,
      totalOffersShipped: "10",
      totalOffersRepriced: "8",
      totalOffersCancelled: "7",
      totalCoverageSettled: "1",
      totalSettledVolume: "1000000000000000000000",
      averageSpreadBps: "200",
      fillReliabilityScore: "12.5", // 1 / (1 + 7) = 12.5%
      reputationTier: "TIER_3_VOLATILE",
      activeOffersCount: "1",
      lastSettlementTimestamp: "1700000000",
    };
    testAgent.setUnderwriterProfile(uBait.address, volatileProfile);

    const txRisky: ProposedTransaction = {
      txRef: "0x4444444444444444444444444444444444444444444444444444444444444444",
      sender: actingAgent.address,
      target: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      asset: "0xE224621223356f15Cf9618007e7C22477067De69",
      amount: 5000n * 10n ** 18n,
      description: "Risky transfer requiring reputable underwriter",
      metadata: { isContract: true, contractVerified: false, ageDays: 1, priorTransfers: 0 },
    };

    const plan = await testAgent.evaluateAndPlan(txRisky);

    assert.strictEqual(plan.proceeded, true);
    assert.strictEqual(plan.hedged, true);
    // Invariant 7: BaitSwitchUnderwriter must be disqualified despite aggressive rate!
    assert.ok(plan.disqualifiedQuotes);
    assert.strictEqual(plan.disqualifiedQuotes.length, 1);
    assert.strictEqual(plan.disqualifiedQuotes[0].quote.underwriterName, "BaitSwitchUnderwriter");
    assert.match(plan.disqualifiedQuotes[0].reason, /TIER_3_VOLATILE/);

    // Best vetted quote remains ApexHedge (TIER_1_PRIME)
    assert.strictEqual(plan.selectedQuote?.underwriterName, "ApexHedge");
    assert.strictEqual(plan.selectedQuote?.effectiveRate, 1.05);
  });
});
