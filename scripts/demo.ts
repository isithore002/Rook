/**
 * DEMO-VERIFIED runner (PROMPTS.md §10): two complete, independent, clean-state
 * end-to-end runs — fresh Anvil, fresh deploy, fresh process state each time —
 * then a field-by-field comparison. With a fixed genesis timestamp and
 * deterministic Anvil the two traces must be byte-identical.
 *
 *   npm run demo
 */
import assert from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";
import { startAnvil, stopAnvil } from "./anvil.ts";
import { deploy } from "./deploy.ts";
import { runDemoOnce, type DemoTrace } from "../flow/runDemo.ts";

const ANVIL_PORT = Number(process.env.RPC_URL?.split(":").pop() || 8545);

async function oneRun(label: string, gatewayPort: number): Promise<DemoTrace> {
  console.log(`\n[demo] --- ${label}: fresh anvil + deploy + full flow ---`);
  const anvil = await startAnvil(ANVIL_PORT);
  try {
    const d = await deploy();
    const trace = await runDemoOnce(d, gatewayPort);
    console.log(`[demo] ${label}: ${trace.scenarios.map((s) => `${s.label}=${s.outcome}`).join(", ")}`);
    console.log(`[demo] ${label}: settlement tx ${trace.scenarios[1].execution?.txHash} block ${trace.scenarios[1].execution?.blockNumber}`);
    return trace;
  } finally {
    await stopAnvil(anvil, ANVIL_PORT);
    await sleep(300);
  }
}

function assertTrace(t: DemoTrace, label: string): void {
  const [safe, risky, blocked] = t.scenarios;
  assert.strictEqual(safe.outcome, "PROCEEDED_UNHEDGED", `${label}: safe`);
  assert.strictEqual(safe.shipped.length, 0, `${label}: safe ships nothing`);
  assert.strictEqual(risky.outcome, "HEDGED_AND_SETTLED", `${label}: risky`);
  assert.strictEqual(risky.selected?.name, "ApexHedge", `${label}: winner`);
  assert.ok(risky.disqualified.some((x) => x.name === "DeltaDynamic"), `${label}: DeltaDynamic disqualified`);
  assert.strictEqual(risky.execution?.coverageRecorded, true, `${label}: coverage on-chain`);
  assert.ok(/^0x[0-9a-f]{64}$/.test(risky.execution?.txHash ?? ""), `${label}: real settlement tx`);
  assert.strictEqual(risky.marketEvents.length, 2, `${label}: live reprice + cancel`);
  assert.strictEqual(blocked.outcome, "HARD_BLOCKED", `${label}: blocked`);
  assert.strictEqual(t.indexed.deltaDynamic.tier, "TIER_3_VOLATILE", `${label}: indexed tier`);
  assert.strictEqual(t.indexed.deltaDynamic.cancelled, "3", `${label}: indexed cancels`);
  assert.strictEqual(t.indexed.alphaConserv.tier, "TIER_1_PRIME", `${label}: prime`);
  assert.strictEqual(t.gateway.x402Protocol, "MPP/1.0", `${label}: x402 header`);
  assert.strictEqual(t.gateway.riskScore.requiresHedge, true, `${label}: gateway score`);
  assert.strictEqual(t.gateway.settlement.isSettled, true, `${label}: gateway reads real settlement`);
  assert.strictEqual(t.gateway.settlement.size, risky.execution?.safeAmountOut, `${label}: gateway size == on-chain size`);
}

async function main(): Promise<void> {
  const runA = await oneRun("RUN A", 3010);
  const runB = await oneRun("RUN B", 3011);

  assertTrace(runA, "RUN A");
  assertTrace(runB, "RUN B");

  // Fixed genesis + deterministic Anvil: the two clean runs must match exactly.
  assert.deepStrictEqual(runA, runB, "two clean-state runs diverged — see the diff above");

  console.log("\n=== DEMO-VERIFIED ===");
  console.log("Two independent clean-state runs produced byte-identical traces.");
  console.log(JSON.stringify(runA, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n[demo] FAILED:", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
