/**
 * Persistent Bazantic Gateway host — the Bazantic bounty requires "deploy an
 * x402/MPP Gateway", which the ephemeral `npm run demo` process can't satisfy
 * on its own (it starts the gateway, runs one comparison, and exits). This
 * script starts a local Anvil + deploys the real Rook stack once, seeds real
 * on-chain underwriter history (the same warmup `runDemoOnce` uses) plus one
 * real run of all 3 MOCKS.md scenarios so /quotes and /settlement have real
 * evidence to return, then keeps the gateway listening indefinitely.
 *
 * Run this, then tunnel BAZANTIC_GATEWAY_PORT (ngrok/Cloudflare Tunnel) to
 * get a public URL for the Bazantic dashboard's "Create Gateway" flow. The
 * chain itself (Anvil) stays local — only the gateway's HTTP port needs to
 * be reachable from outside.
 */
import { startAnvil, stopAnvil } from "./anvil.ts";
import { deploy } from "./deploy.ts";
import { setupDemoGateway, TXREF, ASSET } from "../flow/runDemo.ts";
import { runScenarioLive } from "../flow/runScenarioLive.ts";
import type { ProposedTransaction } from "../agents/types.ts";

const ANVIL_PORT = Number(process.env.RPC_URL?.split(":").pop() || 8545);
const GATEWAY_PORT = Number(process.env.BAZANTIC_GATEWAY_PORT || 3000);

async function main(): Promise<void> {
  console.log(`[serve-gateway] starting anvil on :${ANVIL_PORT}...`);
  const anvil = await startAnvil(ANVIL_PORT);

  console.log("[serve-gateway] deploying Rook stack...");
  const d = await deploy();

  console.log("[serve-gateway] seeding on-chain underwriter history + starting gateway...");
  const { chain, riskService, underwriters, actingAgent, gateway } = await setupDemoGateway(d, GATEWAY_PORT);

  console.log("[serve-gateway] running the 3 MOCKS.md scenarios once for real seed evidence...");
  const txSafe: ProposedTransaction = {
    txRef: TXREF.safe, sender: d.actingAgent, target: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    asset: ASSET, amount: 250n * 10n ** 18n, description: "Routine liquidity rebalance to internal treasury",
    metadata: { isContract: false, priorTransfers: 42 },
  };
  await runScenarioLive({ chain, riskService, underwriters, actingAgent, tx: txSafe, label: "tx-safe-01" });

  const txRisky: ProposedTransaction = {
    txRef: TXREF.risky, sender: d.actingAgent, target: d.demoTarget, asset: ASSET,
    amount: 5000n * 10n ** 18n, description: "High-value swap on newly deployed automated market maker pool",
    metadata: { isContract: true, contractVerified: false, ageDays: 2, priorTransfers: 0 },
  };
  await runScenarioLive({
    chain, riskService, underwriters, actingAgent, tx: txRisky,
    label: "tx-risky-01", target: d.demoTarget, targetUnits: 42n, showMarketDynamics: true,
  });

  const txBlocked: ProposedTransaction = {
    txRef: TXREF.blocked, sender: d.actingAgent, target: d.exploitTarget, asset: ASSET,
    amount: 50000n * 10n ** 18n, description: "High-risk transfer to flagged address",
  };
  await runScenarioLive({
    chain, riskService, underwriters, actingAgent, tx: txBlocked, label: "tx-risky-02", target: d.exploitTarget,
  });

  console.log(`\n[serve-gateway] READY — Bazantic Gateway listening on http://127.0.0.1:${GATEWAY_PORT}`);
  console.log(`[serve-gateway] OpenAPI base path: /api/v1 (see bazantic/openapi.yaml)`);
  console.log(`[serve-gateway] tx-risky-01 settled at txRef ${TXREF.risky} — try GET /api/v1/settlement/${TXREF.risky}`);
  console.log(`[serve-gateway] Point your tunnel (ngrok/cloudflared) at port ${GATEWAY_PORT}, then use the public URL in Bazantic's "Create Gateway" flow.`);
  console.log(`[serve-gateway] Ctrl+C to stop.`);

  const shutdown = async (): Promise<void> => {
    console.log("\n[serve-gateway] shutting down...");
    await gateway.stop();
    await stopAnvil(anvil, ANVIL_PORT);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // BazanticGatewayServer's http.Server keeps the event loop alive on its own.
}

main().catch((err) => {
  console.error("[serve-gateway] FAILED:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
