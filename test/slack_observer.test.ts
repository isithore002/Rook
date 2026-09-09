import assert from "node:assert";
import test from "node:test";
import { SlackObserverService } from "../services/SlackObserverService.ts";
import http from "node:http";

test("SlackObserverService - Incident & Observability Layer", async (t) => {
  await t.test("Fail-Safe: Works silently when no webhook is configured", async () => {
    const observer = new SlackObserverService(undefined);

    const res1 = await observer.notifyHedgeSettled({
      txRef: "0x2222000000000000000000000000000000000000000000000000000000000001",
      riskScore: 90,
      underwriter: "ApexHedge",
      effectiveRate: 1.05,
      coverageAmount: "10,000 USDC",
      settlementStatus: "SUCCESS",
      aquaTxHash: "0x9876543210abcdef",
    });
    assert.strictEqual(res1.sent, false);
    assert.strictEqual(res1.reason, "NO_WEBHOOK_CONFIGURED");

    const res2 = await observer.notifyUnderwriterDisqualified({
      txRef: "0x2222000000000000000000000000000000000000000000000000000000000001",
      provider: "BaitSwitchUnderwriter",
      fillReliabilityScore: "12.5",
      requiredMinimum: 60,
      reputationTier: "TIER_3_VOLATILE",
      action: "Quote excluded from execution consideration",
    });
    assert.strictEqual(res2.sent, false);

    const res3 = await observer.notifySecurityBlock({
      txRef: "0x3333000000000000000000000000000000000000000000000000000000000002",
      riskScore: 100,
      targetAddress: "0x000000000000000000000000000000000000dEaD",
      action: "HARD BLOCKED",
      executionStatus: "PREVENTED (TargetHardBlocked)",
      fundsAtRisk: "50,000 RISK",
    });
    assert.strictEqual(res3.sent, false);
  });

  await t.test("Fail-Safe: Network / Webhook HTTP errors never crash the caller", async () => {
    // Point to an invalid unreachable port
    const brokenObserver = new SlackObserverService("http://127.0.0.1:59999/invalid-webhook");

    const result = await brokenObserver.notifySecurityBlock({
      txRef: "0x3333000000000000000000000000000000000000000000000000000000000002",
      riskScore: 100,
      targetAddress: "0x000000000000000000000000000000000000dEaD",
      action: "HARD BLOCKED",
      executionStatus: "PREVENTED",
      fundsAtRisk: "50,000 RISK",
    });

    // Verifies exception was caught gracefully and didn't bubble up
    assert.strictEqual(result.sent, false);
    assert.ok(result.reason);
  });

  await t.test("Dispatcher: Correctly formats and delivers all 3 high-value events", async () => {
    const receivedPayloads: any[] = [];

    const mockServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        receivedPayloads.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolve) => mockServer.listen(3015, () => resolve()));

    try {
      const observer = new SlackObserverService("http://localhost:3015/webhook");

      // Event 1: Hedge Settled
      await observer.notifyHedgeSettled({
        txRef: "tx-risky-01",
        riskScore: 90,
        underwriter: "ApexHedge",
        effectiveRate: 1.05,
        coverageAmount: "10,000 USDC",
        settlementStatus: "SUCCESS",
        aquaTxHash: "0xabc123",
      });

      // Event 2: Underwriter Disqualified
      await observer.notifyUnderwriterDisqualified({
        txRef: "tx-risky-01",
        provider: "UnknownHedge",
        fillReliabilityScore: 42,
        requiredMinimum: 60,
        reputationTier: "TIER_3_VOLATILE",
        action: "Quote excluded",
      });

      // Event 3: Security Block
      await observer.notifySecurityBlock({
        txRef: "tx-risky-02",
        riskScore: 100,
        targetAddress: "0x...dEaD",
        action: "HARD BLOCKED",
        executionStatus: "PREVENTED",
        fundsAtRisk: "50,000 RISK",
      });

      assert.strictEqual(receivedPayloads.length, 3);

      // Verify Event 1 structure
      assert.strictEqual(receivedPayloads[0].blocks[0].text.text, "🛡️ ROOK HEDGE SETTLED");
      assert.ok(receivedPayloads[0].text.includes("tx-risky-01"));

      // Verify Event 2 structure
      assert.strictEqual(receivedPayloads[1].blocks[0].text.text, "⚠️ ROOK UNDERWRITER DISQUALIFIED");
      assert.ok(receivedPayloads[1].text.includes("UnknownHedge"));

      // Verify Event 3 structure
      assert.strictEqual(receivedPayloads[2].blocks[0].text.text, "🚨 ROOK SECURITY BLOCK");
      assert.ok(receivedPayloads[2].text.includes("tx-risky-02"));
    } finally {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });
});
