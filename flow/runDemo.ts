/**
 * One complete Rook demo run against an already-deployed stack: builds real
 * underwriter history on-chain, derives profiles via the indexer (The Graph
 * role), starts the Bazantic gateway wired to the real RookRegistry, and drives
 * all three MOCKS.md scenarios through the agents -> SwapVM fills -> settlement.
 * Returns a fully structured trace so two runs can be compared field-by-field.
 */
import { keccak256, toHex, type Address } from "viem";
import { RiskScoringService } from "../services/RiskScoringService.ts";
import { UnderwriterAgent } from "../agents/UnderwriterAgent.ts";
import { ActingAgent } from "../agents/ActingAgent.ts";
import { RookChain } from "../chain/rookChain.ts";
import { RookIndexer } from "../services/RookIndexer.ts";
import { BazanticGatewayServer, type SettlementInfo } from "../services/BazanticGatewayServer.ts";
import { publicClient, type Deployment } from "../chain/config.ts";
import { runScenarioLive, type LiveScenarioTrace } from "./runScenarioLive.ts";
import type { ProposedTransaction, RiskResult } from "../agents/types.ts";

const ASSET = "0xE224621223356f15Cf9618007e7C22477067De69";
const TXREF = {
  safe: "0x1111111111111111111111111111111111111111111111111111111111111111",
  risky: "0x2222222222222222222222222222222222222222222222222222222222222222",
  blocked: "0x3333333333333333333333333333333333333333333333333333333333333333",
} as const;

export interface DemoTrace {
  scenarios: LiveScenarioTrace[];
  indexed: {
    deltaDynamic: { reliability: string; tier: string; cancelled: string; settled: string };
    alphaConserv: { tier: string };
  };
  gateway: {
    x402Protocol: string | null;
    riskScore: Pick<RiskResult, "riskScore" | "hardBlock" | "requiresHedge">;
    settlement: SettlementInfo & { txRef: string };
  };
}

export async function runDemoOnce(d: Deployment, gatewayPort: number): Promise<DemoTrace> {
  const chain = new RookChain(d);
  const riskService = new RiskScoringService();
  const [u1, u2, u3] = d.underwriters as [Address, Address, Address];
  const underwriters = [
    new UnderwriterAgent(u1, "AlphaConserv", "conservative"),
    new UnderwriterAgent(u2, "ApexHedge", "aggressive"),
    new UnderwriterAgent(u3, "DeltaDynamic", "dynamic"),
  ];
  const actingAgent = new ActingAgent(d.actingAgent, riskService, underwriters);

  // --- real on-chain history: DeltaDynamic ships + revokes, others reprice ---
  const soon = await chain.validWhile(1);
  for (let i = 0; i < 3; i++) {
    const id = keccak256(toHex(`warmup-bad-${i}`));
    await chain.shipOffer(u3, id, 10800n, 10000n, 1000n * 10n ** 18n, soon);
    await chain.cancelOffer(u3, id);
  }
  for (const good of [u1, u2]) {
    const id = keccak256(toHex(`warmup-good-${good}`));
    await chain.shipOffer(good, id, 10400n, 10000n, 2000n * 10n ** 18n, soon);
    await chain.repriceOffer(good, id, 10350n, 10000n);
  }

  // --- The Graph role: derive profiles from the real logs ---
  const indexer = new RookIndexer(publicClient(), d);
  await indexer.sync();
  for (const uw of [u1, u2, u3]) {
    const prof = indexer.getUnderwriterProfile(uw);
    if (prof) actingAgent.setUnderwriterProfile(uw, prof);
  }
  const dd = indexer.getUnderwriterProfile(u3)!;
  const ac = indexer.getUnderwriterProfile(u1)!;

  // --- Bazantic role: gateway wired to the real registry ---
  const gateway = new BazanticGatewayServer({
    port: gatewayPort,
    settlementLookup: async (txRef): Promise<SettlementInfo> => {
      if (!(await chain.hasCoverage(txRef as `0x${string}`))) return { isSettled: false };
      const c = (await chain.getCoverage(txRef as `0x${string}`)) as {
        underwriter: Address; rate: bigint; size: bigint; timestamp: bigint;
      };
      return {
        isSettled: true,
        underwriter: c.underwriter,
        rate: c.rate.toString(),
        size: c.size.toString(),
        timestamp: Number(c.timestamp),
      };
    },
  });
  await gateway.start();

  try {
    const scenarios: LiveScenarioTrace[] = [];

    const txSafe: ProposedTransaction = {
      txRef: TXREF.safe, sender: d.actingAgent, target: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      asset: ASSET, amount: 250n * 10n ** 18n, description: "Routine liquidity rebalance to internal treasury",
      metadata: { isContract: false, priorTransfers: 42 },
    };
    scenarios.push(await runScenarioLive({ chain, riskService, underwriters, actingAgent, tx: txSafe, label: "tx-safe-01" }));

    const txRisky: ProposedTransaction = {
      txRef: TXREF.risky, sender: d.actingAgent, target: d.demoTarget, asset: ASSET,
      amount: 5000n * 10n ** 18n, description: "High-value swap on newly deployed automated market maker pool",
      metadata: { isContract: true, contractVerified: false, ageDays: 2, priorTransfers: 0 },
    };
    // Bazantic Ingredient 1: score via the gateway (real risk service + x402 header).
    const scoreRes = await fetch(`http://127.0.0.1:${gatewayPort}/api/v1/score`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...txRisky, amount: txRisky.amount.toString() }),
    });
    const x402Protocol = scoreRes.headers.get("x-402-protocol");
    const riskScore = (await scoreRes.json()) as RiskResult;

    scenarios.push(await runScenarioLive({
      chain, riskService, underwriters, actingAgent, tx: txRisky,
      label: "tx-risky-01", target: d.demoTarget, targetUnits: 42n, showMarketDynamics: true,
    }));

    // Bazantic Ingredient 4: verify settlement proof against the real registry.
    const settlement = (await (
      await fetch(`http://127.0.0.1:${gatewayPort}/api/v1/settlement/${TXREF.risky}`)
    ).json()) as SettlementInfo & { txRef: string };

    const txBlocked: ProposedTransaction = {
      txRef: TXREF.blocked, sender: d.actingAgent, target: d.exploitTarget, asset: ASSET,
      amount: 50000n * 10n ** 18n, description: "High-risk transfer to flagged address",
    };
    scenarios.push(await runScenarioLive({
      chain, riskService, underwriters, actingAgent, tx: txBlocked, label: "tx-risky-02", target: d.exploitTarget,
    }));

    return {
      scenarios,
      indexed: {
        deltaDynamic: {
          reliability: dd.fillReliabilityScore, tier: dd.reputationTier,
          cancelled: dd.totalOffersCancelled, settled: dd.totalCoverageSettled,
        },
        alphaConserv: { tier: ac.reputationTier },
      },
      gateway: {
        x402Protocol,
        riskScore: { riskScore: riskScore.riskScore, hardBlock: riskScore.hardBlock, requiresHedge: riskScore.requiresHedge },
        settlement,
      },
    };
  } finally {
    await gateway.stop();
  }
}
