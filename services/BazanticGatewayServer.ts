import http from "node:http";
import { RiskScoringService } from "./RiskScoringService.ts";
import { UnderwriterAgent } from "../agents/UnderwriterAgent.ts";
import type { ProposedTransaction } from "../agents/types.ts";

export interface SettlementInfo {
  isSettled: boolean;
  underwriter?: string;
  rate?: string;
  size?: string;
  timestamp?: number;
}

/** Resolves a txRef to real settlement state. The demo injects a RookRegistry-backed lookup. */
export type SettlementLookup = (txRef: string) => Promise<SettlementInfo>;

export interface GatewayOpts {
  port?: number;
  settlementLookup?: SettlementLookup;
}

/**
 * Bazantic Gateway Server
 * Implements the OpenAPI 3.0 endpoints and x402 machine payment verification
 * for Rook's agent-facing hedging ingredients.
 */
export class BazanticGatewayServer {
  private server: http.Server | null = null;
  private readonly port: number;
  private readonly riskService: RiskScoringService;
  private readonly underwriters: UnderwriterAgent[];
  private readonly settlementLookup: SettlementLookup;

  constructor(portOrOpts: number | GatewayOpts = 3000) {
    const opts: GatewayOpts = typeof portOrOpts === "number" ? { port: portOrOpts } : portOrOpts;
    this.port = opts.port ?? 3000;
    // Default: never report a settlement without evidence (CLAUDE.md §3.8).
    this.settlementLookup = opts.settlementLookup ?? (async () => ({ isSettled: false }));
    this.riskService = new RiskScoringService();
    this.underwriters = [
      new UnderwriterAgent("0x2221000000000000000000000000000000000001", "AlphaConserv", "conservative"),
      new UnderwriterAgent("0x2222000000000000000000000000000000000002", "ApexHedge", "aggressive"),
      new UnderwriterAgent("0x2223000000000000000000000000000000000003", "DeltaDynamic", "dynamic"),
    ];
  }

  public start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.listen(this.port, () => {
        resolve();
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    const method = req.method;

    // CORS & x402 headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-402-Payment");
    res.setHeader("X-402-Protocol", "MPP/1.0");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // 1. POST /api/v1/score (Ingredient: scoreTransactionRisk)
      if (pathname === "/api/v1/score" && method === "POST") {
        const body = await this.readJsonBody<ProposedTransaction>(req);
        // Normalize amount to bigint if passed as string
        if (typeof body.amount === "string" || typeof body.amount === "number") {
          body.amount = BigInt(body.amount);
        }
        const result = await this.riskService.scoreTransaction(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      // 2. GET /api/v1/quotes (Ingredient: discoverHedgeQuotes)
      if (pathname === "/api/v1/quotes" && method === "GET") {
        const dummyTx: ProposedTransaction = {
          txRef: "0x2222222222222222222222222222222222222222222222222222222222222222",
          sender: "0x3333333333333333333333333333333333333333",
          target: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
          asset: "0xE224621223356f15Cf9618007e7C22477067De69",
          amount: 5000n * 10n ** 18n,
          description: "High-value swap query",
        };
        const risk = await this.riskService.scoreTransaction(dummyTx);
        const quotes = this.underwriters
          .map((u) => u.generateQuote(dummyTx, risk))
          .filter(Boolean)
          .map((q) => ({
            ...q,
            rateMultiplier: q?.rateMultiplier.toString(),
            rateDivider: q?.rateDivider.toString(),
            maxCapacity: q?.maxCapacity.toString(),
          }));

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(quotes));
        return;
      }

      // 3. POST /api/v1/prepare-swap (Ingredient: prepareHedgeSwap)
      if (pathname === "/api/v1/prepare-swap" && method === "POST") {
        const body = await this.readJsonBody<{ quoteId: string; amount: string; taker: string }>(req);
        if (!body.quoteId || !body.amount || !body.taker) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid swap request parameters: quoteId, amount, and taker are required." }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            routerAddress: "0x9454B3623f7b5be28F3AbaC728672E301C94E058",
            quoteId: body.quoteId,
            amountIn: body.amount,
            expectedSafeOut: (BigInt(body.amount) * 100n / 105n).toString(),
            calldata: "0x5500000000000000000000000000000000000000",
          })
        );
        return;
      }

      // 4. GET /api/v1/settlement/:txRef (Ingredient: verifySettlementProof)
      if (pathname.startsWith("/api/v1/settlement/") && method === "GET") {
        const txRef = pathname.replace("/api/v1/settlement/", "").toLowerCase();
        const info = await this.settlementLookup(txRef);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ txRef, ...info }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Endpoint not found" }));
    } catch (err: unknown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(data || "{}") as T);
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });
  }
}
