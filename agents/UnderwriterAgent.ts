import type { HedgeQuote, ProposedTransaction, RiskResult } from "./types.ts";

export type UnderwriterStrategy = "conservative" | "aggressive" | "dynamic";

/**
 * Per-strategy pricing sensitivities. Spread (basis points, denominator 10_000)
 * is `base + kRisk·riskScore + kInv·fillFraction²`, so each underwriter reacts
 * differently to the same risk event and the winner changes with the inputs:
 *
 *  - conservative — wide floor, barely moves with risk, tolerates large fills.
 *    Rarely the cheapest on a small ticket; wins when a fill is a big fraction
 *    of the book because its inventory penalty is shallow.
 *  - aggressive — thin floor, cheapest on small/medium tickets, but a steep
 *    convex inventory penalty makes it expensive once a fill eats its capacity.
 *  - dynamic — moderate floor, highly risk-sensitive: competitive at low/medium
 *    risk, the worst quote at extreme risk.
 */
interface StrategyParams {
  baseBps: number;
  kRisk: number;
  kInventoryBps: number;
  capacity: bigint;
}

const STRATEGY: Record<UnderwriterStrategy, StrategyParams> = {
  conservative: { baseBps: 700, kRisk: 1.5, kInventoryBps: 1200, capacity: 40_000n * 10n ** 18n },
  aggressive: { baseBps: 120, kRisk: 3.0, kInventoryBps: 5000, capacity: 50_000n * 10n ** 18n },
  dynamic: { baseBps: 300, kRisk: 8.0, kInventoryBps: 2500, capacity: 30_000n * 10n ** 18n },
};

const RATE_DENOMINATOR = 10_000n;

/**
 * Underwriter Agent
 * Prices each risk event from (risk score, fill size vs. remaining book) with a
 * strategy-specific curve, and ships/reprices/cancels the resulting offer.
 */
export class UnderwriterAgent {
  public readonly address: string;
  public readonly name: string;
  public readonly strategy: UnderwriterStrategy;

  private readonly params: StrategyParams;
  /** Capacity already promised to live offers — raises the price of the next quote. */
  private committed = 0n;

  constructor(address: string, name: string, strategy: UnderwriterStrategy) {
    this.address = address;
    this.name = name;
    this.strategy = strategy;
    this.params = STRATEGY[strategy];
  }

  /** Remaining SAFE the underwriter can still back. */
  public remainingCapacity(): bigint {
    const rem = this.params.capacity - this.committed;
    return rem > 0n ? rem : 0n;
  }

  /** Call after an offer is shipped so subsequent quotes price in the exposure. */
  public recordShipped(amount: bigint): void {
    this.committed += amount;
  }

  /** Call after an offer is cancelled / expired to free the capacity. */
  public releaseShipped(amount: bigint): void {
    this.committed = this.committed > amount ? this.committed - amount : 0n;
  }

  /**
   * Price and generate a hedge quote for a risky transaction.
   * Returns `null` if hard-blocked or the remaining book can't cover the fill.
   */
  public generateQuote(tx: ProposedTransaction, risk: RiskResult): HedgeQuote | null {
    if (risk.hardBlock) return null;

    const remaining = this.remainingCapacity();
    if (remaining < tx.amount || remaining === 0n) return null;

    // fillFraction in [0,1] scaled by 1000 for integer-ish math, then squared.
    const fillMilli = Number((tx.amount * 1000n) / remaining); // 0..1000
    const fillFraction = Math.min(1, fillMilli / 1000);
    const inventoryBps = Math.round(this.params.kInventoryBps * fillFraction * fillFraction);
    const riskBps = Math.round(this.params.kRisk * risk.riskScore);
    const spreadBps = this.params.baseBps + riskBps + inventoryBps;

    const rateNumerator = RATE_DENOMINATOR + BigInt(spreadBps);
    const effectiveRate = Number(rateNumerator) / Number(RATE_DENOMINATOR);
    const validWhile = Math.floor(Date.now() / 1000) + 86_400;

    return {
      quoteId: `quote-${this.strategy}-${tx.txRef.slice(0, 10)}`,
      underwriter: this.address,
      underwriterName: this.name,
      rateMultiplier: rateNumerator,
      rateDivider: RATE_DENOMINATOR,
      effectiveRate,
      maxCapacity: remaining,
      validWhile,
    };
  }
}
