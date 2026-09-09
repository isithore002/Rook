import type { HedgeQuote, ProposedTransaction, RiskResult } from "./types.ts";

export type UnderwriterStrategy = "conservative" | "aggressive" | "dynamic";

/**
 * Underwriter Agent
 * Evaluates risk events and submits competitive, distinct hedge quotes.
 */
export class UnderwriterAgent {
  public readonly address: string;
  public readonly name: string;
  public readonly strategy: UnderwriterStrategy;

  constructor(address: string, name: string, strategy: UnderwriterStrategy) {
    this.address = address;
    this.name = name;
    this.strategy = strategy;
  }

  /**
   * Price and generate a hedge quote for a risky transaction
   * @param tx The proposed risky transaction
   * @param risk The risk assessment
   * @returns Generated hedge quote
   */
  public generateQuote(tx: ProposedTransaction, risk: RiskResult): HedgeQuote | null {
    // If transaction is hard blocked, underwriter will not quote
    if (risk.hardBlock) {
      return null;
    }

    let rateNumerator = 100n;
    let rateDenominator = 100n;
    let maxCapacity = 100_000n * 10n ** 18n;

    switch (this.strategy) {
      case "conservative":
        // 1.25 RISK : 1 SAFE (25% spread)
        rateNumerator = 125n;
        rateDenominator = 100n;
        maxCapacity = 15_000n * 10n ** 18n;
        break;

      case "aggressive":
        // 1.05 RISK : 1 SAFE (5% spread - most competitive)
        rateNumerator = 105n;
        rateDenominator = 100n;
        maxCapacity = 50_000n * 10n ** 18n;
        break;

      case "dynamic":
        // Scales with risk score: 1.00 + (riskScore * 0.002)
        // For riskScore 75: 1.00 + 0.15 = 1.15 (115 / 100)
        const spreadPoints = BigInt(Math.round(risk.riskScore * 0.2));
        rateNumerator = 100n + spreadPoints;
        rateDenominator = 100n;
        maxCapacity = 30_000n * 10n ** 18n;
        break;
    }

    const effectiveRate = Number(rateNumerator) / Number(rateDenominator);
    const validWhile = Math.floor(Date.now() / 1000) + 86400; // 24 hour validity

    return {
      quoteId: `quote-${this.strategy}-${tx.txRef.slice(0, 10)}`,
      underwriter: this.address,
      underwriterName: this.name,
      rateMultiplier: rateNumerator,
      rateDivider: rateDenominator,
      effectiveRate,
      maxCapacity,
      validWhile,
    };
  }
}
