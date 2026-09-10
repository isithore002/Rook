/**
 * End-to-end live proof: spins up a fresh Anvil node, deploys the full Rook
 * stack, and drives the three MOCKS.md scenarios through the real agents ->
 * real SwapVM 0x55 fills -> real RookRegistry settlement. Prints a trace with
 * real transaction hashes and exits non-zero on any assertion failure.
 *
 *   npm run e2e
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createPublicClient, http, type Address } from "viem";

import { RiskScoringService } from "../services/RiskScoringService.ts";
import { UnderwriterAgent } from "../agents/UnderwriterAgent.ts";
import { ActingAgent } from "../agents/ActingAgent.ts";
import { RookChain } from "../chain/rookChain.ts";
import { deploy } from "./deploy.ts";
import { runScenarioLive, type LiveScenarioTrace } from "../flow/runScenarioLive.ts";
import type { SubgraphUnderwriterProfile } from "../services/GraphClientService.ts";
import type { ProposedTransaction } from "../agents/types.ts";

const PORT = Number(process.env.RPC_URL?.split(":").pop() || 8545);
const RPC = `http://127.0.0.1:${PORT}`;
const ASSET = "0xE224621223356f15Cf9618007e7C22477067De69";

let anvil: ChildProcess | undefined;

async function waitForRpc(timeoutMs = 15_000): Promise<void> {
  const client = createPublicClient({ transport: http(RPC) });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await client.getBlockNumber();
      return;
    } catch {
      await sleep(300);
    }
  }
  throw new Error(`Anvil did not come up on ${RPC}`);
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main(): Promise<void> {
  console.log(`[e2e] starting anvil on ${PORT}`);
  // Rook contracts are compiled with the Yul optimizer disabled (see foundry.toml
  // `novia` profile — the full optimizer OOMs solc on this machine), so bytecode
  // runs large. Lift Anvil's EIP-170/3860 size limits for the local run.
  anvil = spawn(
    "anvil",
    ["--port", String(PORT), "--silent", "--disable-code-size-limit", "--gas-limit", "18000000000"],
    { stdio: "ignore" },
  );
  await waitForRpc();

  console.log("[e2e] deploying Rook stack (viem, from swap-vm/out artifacts)");
  const d = await deploy();
  const chain = new RookChain(d);
  console.log(`[e2e] router=${d.router} registry=${d.registry} executor=${d.executor}`);

  const riskService = new RiskScoringService();
  const [u1, u2, u3] = d.underwriters as [Address, Address, Address];
  const underwriters = [
    new UnderwriterAgent(u1, "AlphaConserv", "conservative"),
    new UnderwriterAgent(u2, "ApexHedge", "aggressive"),
    new UnderwriterAgent(u3, "DeltaDynamic", "dynamic"),
  ];
  const actingAgent = new ActingAgent(d.actingAgent, riskService, underwriters);

  // Graph-derived profile: mark DeltaDynamic volatile so vetting disqualifies it live.
  const volatile: SubgraphUnderwriterProfile = {
    underwriter: u3, totalOffersShipped: "10", totalOffersRepriced: "9", totalOffersCancelled: "8",
    totalCoverageSettled: "1", totalSettledVolume: "1", averageSpreadBps: "300",
    fillReliabilityScore: "0.11", reputationTier: "TIER_3_VOLATILE", activeOffersCount: "1",
    lastSettlementTimestamp: "1700000000",
  };
  actingAgent.setUnderwriterProfile(u3, volatile);

  const traces: LiveScenarioTrace[] = [];

  // --- tx-safe-01 ---
  const txSafe: ProposedTransaction = {
    txRef: "0x1111111111111111111111111111111111111111111111111111111111111111",
    sender: d.actingAgent, target: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", asset: ASSET,
    amount: 250n * 10n ** 18n, description: "Routine liquidity rebalance to internal treasury",
    metadata: { isContract: false, priorTransfers: 42 },
  };
  traces.push(await runScenarioLive({ chain, riskService, underwriters, actingAgent, tx: txSafe, label: "tx-safe-01" }));

  // --- tx-risky-01 ---
  const txRisky: ProposedTransaction = {
    txRef: "0x2222222222222222222222222222222222222222222222222222222222222222",
    sender: d.actingAgent, target: d.demoTarget, asset: ASSET,
    amount: 5000n * 10n ** 18n, description: "High-value swap on newly deployed automated market maker pool",
    metadata: { isContract: true, contractVerified: false, ageDays: 2, priorTransfers: 0 },
  };
  traces.push(await runScenarioLive({
    chain, riskService, underwriters, actingAgent, tx: txRisky, label: "tx-risky-01",
    target: d.demoTarget, targetUnits: 42n, showMarketDynamics: true,
  }));

  // --- tx-risky-02 ---
  const txBlocked: ProposedTransaction = {
    txRef: "0x3333333333333333333333333333333333333333333333333333333333333333",
    sender: d.actingAgent, target: d.exploitTarget, asset: ASSET,
    amount: 50000n * 10n ** 18n, description: "High-risk transfer to flagged address",
  };
  traces.push(await runScenarioLive({
    chain, riskService, underwriters, actingAgent, tx: txBlocked, label: "tx-risky-02", target: d.exploitTarget,
  }));

  console.log("\n=== LIVE E2E TRACE ===");
  console.log(JSON.stringify(traces, null, 2));

  const [safe, risky, blocked] = traces;
  assert(safe.outcome === "PROCEEDED_UNHEDGED", "tx-safe-01 must proceed unhedged");
  assert(safe.shipped.length === 0, "tx-safe-01 must not ship offers");

  assert(risky.outcome === "HEDGED_AND_SETTLED", "tx-risky-01 must hedge and settle");
  assert(risky.shipped.length >= 2, "tx-risky-01 must have competing shipped offers");
  assert(risky.selected?.name === "ApexHedge", "tx-risky-01 best quote must be ApexHedge");
  assert(risky.disqualified.some((x) => x.name === "DeltaDynamic"), "DeltaDynamic must be disqualified by Graph profile");
  assert(risky.execution?.coverageRecorded === true, "RookRegistry must record the coverage on-chain");
  assert(/^0x[0-9a-f]{64}$/.test(risky.execution?.txHash ?? ""), "execution must have a real tx hash");
  assert(risky.marketEvents.length === 2, "live reprice + cancel must be observed");

  // Independent confirmation straight from the registry.
  const cov = (await chain.getCoverage(risky.txRef)) as { size: bigint; underwriter: Address };
  assert(cov.size > 0n, "registry getCoverage size must be > 0");

  assert(blocked.outcome === "HARD_BLOCKED", "tx-risky-02 must fail closed");
  assert(blocked.shipped.length === 0, "tx-risky-02 must not ship or fill");

  console.log("\n[e2e] ALL ASSERTIONS PASSED");
  console.log(`[e2e] settlement tx: ${risky.execution?.txHash}  block ${risky.execution?.blockNumber}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n[e2e] FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => {
    anvil?.kill("SIGTERM");
  });
