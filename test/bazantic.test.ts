import assert from "node:assert";
import test from "node:test";
import { BazanticGatewayServer } from "../services/BazanticGatewayServer.ts";

test("Bazantic Gateway & Recipe Flow", async (t) => {
  const server = new BazanticGatewayServer(3001);
  await server.start();

  t.after(async () => {
    await server.stop();
  });

  await t.test("Ingredient 1: scoreTransactionRisk (POST /api/v1/score)", async () => {
    const payload = {
      txRef: "0x2222222222222222222222222222222222222222222222222222222222222222",
      sender: "0x3333333333333333333333333333333333333333",
      target: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      asset: "0xE224621223356f15Cf9618007e7C22477067De69",
      amount: "5000000000000000000000",
      description: "High-value swap on newly deployed automated market maker pool",
      metadata: {
        isContract: true,
        contractVerified: false,
        ageDays: 2,
        priorTransfers: 0,
      },
    };

    const res = await fetch("http://localhost:3001/api/v1/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("x-402-protocol"), "MPP/1.0");

    const data = (await res.json()) as { riskScore: number; requiresHedge: boolean; hardBlock: boolean };
    assert.strictEqual(data.hardBlock, false);
    assert.strictEqual(data.requiresHedge, true);
    assert.ok(data.riskScore >= 50);
  });

  await t.test("Ingredient 2: discoverHedgeQuotes (GET /api/v1/quotes)", async () => {
    const res = await fetch("http://localhost:3001/api/v1/quotes");
    assert.strictEqual(res.status, 200);

    const quotes = (await res.json()) as Array<{ underwriterName: string; effectiveRate: number }>;
    assert.strictEqual(quotes.length, 3);

    const apexQuote = quotes.find((q) => q.underwriterName === "ApexHedge");
    assert.ok(apexQuote);
    // Computed pricing (P1.7): ApexHedge is the cheapest of the three on this ticket.
    assert.ok(apexQuote.effectiveRate > 1 && apexQuote.effectiveRate < 1.1);
    assert.ok(quotes.every((q) => q.underwriterName === "ApexHedge" || q.effectiveRate >= apexQuote.effectiveRate));
  });

  await t.test("Ingredient 3: prepareHedgeSwap (POST /api/v1/prepare-swap)", async () => {
    const payload = {
      quoteId: "quote-aggressive-0x2222",
      amount: "5250000000000000000000",
      taker: "0x3333333333333333333333333333333333333333",
    };

    const res = await fetch("http://localhost:3001/api/v1/prepare-swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    assert.strictEqual(res.status, 200);
    const data = (await res.json()) as { routerAddress: string; calldata: string };
    assert.ok(data.routerAddress);
    assert.ok(data.calldata);
  });

  await t.test("Ingredient 4: verifySettlementProof (GET /api/v1/settlement/:txRef)", async () => {
    const txRef = "0x2222222222222222222222222222222222222222222222222222222222222222";
    const res = await fetch(`http://localhost:3001/api/v1/settlement/${txRef}`);
    assert.strictEqual(res.status, 200);

    const data = (await res.json()) as { txRef: string; isSettled: boolean };
    assert.strictEqual(data.txRef, txRef);
    assert.strictEqual(data.isSettled, true);
  });
});
