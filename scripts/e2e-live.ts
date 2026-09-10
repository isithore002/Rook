/**
 * Single-run live smoke: fresh Anvil -> deploy -> one full demo run through the
 * real agents / SwapVM fills / RookRegistry settlement, with assertions and a
 * printed trace. For the two-run reproducibility proof, use `npm run demo`.
 *
 *   npm run e2e
 */
import assert from "node:assert";
import { startAnvil, stopAnvil } from "./anvil.ts";
import { deploy } from "./deploy.ts";
import { runDemoOnce } from "../flow/runDemo.ts";

const PORT = Number(process.env.RPC_URL?.split(":").pop() || 8545);

async function main(): Promise<void> {
  const anvil = await startAnvil(PORT);
  try {
    console.log("[e2e] deploying Rook stack (viem, from swap-vm/out artifacts)");
    const d = await deploy();
    console.log(`[e2e] router=${d.router} registry=${d.registry} executor=${d.executor}`);

    const t = await runDemoOnce(d, 3009);
    console.log("\n=== LIVE E2E TRACE ===");
    console.log(JSON.stringify(t, null, 2));

    const [safe, risky, blocked] = t.scenarios;
    assert.strictEqual(safe.outcome, "PROCEEDED_UNHEDGED", "tx-safe-01 proceeds unhedged");
    assert.strictEqual(safe.shipped.length, 0, "tx-safe-01 ships nothing");
    assert.strictEqual(risky.outcome, "HEDGED_AND_SETTLED", "tx-risky-01 hedges and settles");
    assert.strictEqual(risky.selected?.name, "ApexHedge", "best quote is ApexHedge");
    assert.ok(risky.disqualified.some((x) => x.name === "DeltaDynamic"), "DeltaDynamic disqualified by indexed history");
    assert.strictEqual(risky.execution?.coverageRecorded, true, "RookRegistry recorded the coverage");
    assert.ok(/^0x[0-9a-f]{64}$/.test(risky.execution?.txHash ?? ""), "real settlement tx hash");
    assert.strictEqual(blocked.outcome, "HARD_BLOCKED", "tx-risky-02 fails closed");
    assert.strictEqual(t.indexed.deltaDynamic.tier, "TIER_3_VOLATILE", "indexer derived volatile tier from real revokes");
    assert.strictEqual(t.gateway.settlement.isSettled, true, "Bazantic gateway reads the real settlement");
    assert.strictEqual(t.gateway.settlement.size, risky.execution?.safeAmountOut, "gateway size matches on-chain");

    console.log("\n[e2e] ALL ASSERTIONS PASSED");
    console.log(`[e2e] settlement tx: ${risky.execution?.txHash}  block ${risky.execution?.blockNumber}`);
    console.log(
      `[e2e] indexed DeltaDynamic: reliability=${t.indexed.deltaDynamic.reliability} tier=${t.indexed.deltaDynamic.tier} ` +
        `(cancelled=${t.indexed.deltaDynamic.cancelled}, settled=${t.indexed.deltaDynamic.settled})`,
    );
  } finally {
    await stopAnvil(anvil, PORT);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n[e2e] FAILED:", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
