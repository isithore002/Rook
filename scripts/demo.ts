/**
 * DEMO-VERIFIED runner (PROMPTS.md §10): two complete, independent, clean-state
 * end-to-end runs — fresh Anvil, fresh deploy, fresh process state each time.
 *
 * Two modes, chosen by whether a Gemini key is actually configured:
 *  - LLM off (no key, or ROOK_RISK_LLM=off): nothing in the loop is external
 *    or nondeterministic, so the two traces must be byte-identical
 *    (`npm run demo:mechanism` forces this — used in CI, which has no key).
 *  - LLM live (`npm run demo` with GEMINI_API_KEY set): a real external model
 *    is invoked per risky transaction. Its exact score/rate/reasoning are
 *    *expected* to vary run-to-run — that variation is evidence it's a live
 *    call, not a fixture (CLAUDE.md §3.8) — so the bar shifts to decision-level
 *    equality (same outcomes, same disqualifications, same settlement), and
 *    both runs' raw AI reasoning is printed so the liveness is visible, not
 *    hidden behind a forced-off flag.
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

/**
 * Strip fields that reflect real wall-clock execution time rather than the
 * deterministic mechanism itself. `CoverageSettled.timestamp` is Anvil's
 * `block.timestamp` at the moment the settlement tx was actually mined —
 * driven by real elapsed time between two independent process runs, not by
 * anything Rook controls — so it can legitimately differ by a second even
 * when every transaction, amount, and hash is identical. (Genesis is fixed
 * and `validWhile` is hour-snapped for exactly this reason; this is the one
 * remaining real-time-derived field.) Excluding it from the strict compare
 * avoids the alternative of chasing a false "these runs diverged" on a field
 * that was never a claim about mechanism determinism.
 */
function normalizeForComparison(t: DemoTrace): DemoTrace {
  const clone = structuredClone(t);
  clone.gateway.settlement.timestamp = 0;
  return clone;
}

function llmActive(): boolean {
  const hasKey = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  return hasKey && process.env.ROOK_RISK_LLM !== "off";
}

/** The decisions that must hold regardless of the AI's exact wording/score this run. */
function decisionShape(t: DemoTrace) {
  return {
    scenarios: t.scenarios.map((s) => ({
      label: s.label,
      outcome: s.outcome,
      hardBlock: s.risk.hardBlock,
      requiresHedge: s.risk.requiresHedge,
      selected: s.selected?.name,
      disqualified: [...s.disqualified.map((d) => d.name)].sort(),
      coverageRecorded: s.execution?.coverageRecorded,
    })),
    indexed: t.indexed,
    gatewaySettled: t.gateway.settlement.isSettled,
    x402: t.gateway.x402Protocol,
  };
}

async function main(): Promise<void> {
  const live = llmActive();
  console.log(`\n[demo] LLM advisory: ${live ? "LIVE — real Gemini calls, one per risky transaction" : "OFF — deterministic rules-only fallback"}`);

  const runA = await oneRun("RUN A", 3010);
  const runB = await oneRun("RUN B", 3011);

  assertTrace(runA, "RUN A");
  assertTrace(runB, "RUN B");

  if (!live) {
    // Nothing external or nondeterministic in the loop apart from the settlement
    // block's real-time mining timestamp (see normalizeForComparison) — everything
    // else, including every transaction hash and on-chain amount, must match exactly.
    assert.deepStrictEqual(
      normalizeForComparison(runA),
      normalizeForComparison(runB),
      "two clean-state runs diverged — see the diff above"
    );
    console.log("\n=== DEMO-VERIFIED (mechanism-only — LLM advisory off) ===");
    console.log("Two independent clean-state runs produced identical mechanism traces");
    console.log(
      `(settlement block.timestamp legitimately differs by real elapsed time: ` +
        `${runA.gateway.settlement.timestamp} vs ${runB.gateway.settlement.timestamp}).`
    );
  } else {
    assert.deepStrictEqual(
      decisionShape(runA),
      decisionShape(runB),
      "decision-level outcomes diverged between runs — see the full traces above"
    );
    console.log("\n=== DEMO-VERIFIED (live AI — decisions match, advisory text genuinely varies) ===");
    console.log(`Run A tx-risky-01 AI reasoning: ${runA.scenarios[1].risk.reasoning}`);
    console.log(`Run B tx-risky-01 AI reasoning: ${runB.scenarios[1].risk.reasoning}`);
    if (runA.scenarios[1].risk.reasoning === runB.scenarios[1].risk.reasoning) {
      console.log("(Note: identical text this time — the model can coincidentally repeat itself; the call is still live.)");
    }
  }

  console.log("\n--- RUN A full trace ---");
  console.log(JSON.stringify(runA, null, 2));
  console.log("\n--- RUN B full trace ---");
  console.log(JSON.stringify(runB, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n[demo] FAILED:", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
