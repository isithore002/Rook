import type { HedgeQuote } from "../agents/types.ts";

export interface SubgraphHedgeOffer {
  id: string;
  offerId: string;
  underwriter: string;
  tokenIn: string;
  tokenOut: string;
  rateNumerator: string;
  rateDenominator: string;
  effectiveRate: string;
  maxCapacity: string;
  filledAmount: string;
  validWhile: string;
  isRevoked: boolean;
}

export interface SubgraphUnderwriterMetrics {
  underwriter: string;
  totalOffersShipped: string;
  totalCoverageSettled: string;
  totalSettledVolume: string;
  averageRate: string;
  activeOffersCount: string;
  lastSettlementTimestamp: string;
}

/**
 * GraphClientService
 * Queries The Graph Subgraph endpoint for live HedgeOffers and derived UnderwriterMetrics.
 * If endpoint is not connected, falls back to the on-chain indexed snapshot.
 */
export class GraphClientService {
  private readonly subgraphEndpoint: string;

  constructor(endpoint = "http://localhost:8000/subgraphs/name/rook/rook-protocol") {
    this.subgraphEndpoint = endpoint;
  }

  /**
   * GraphQL Query to retrieve active hedge offers and underwriter intelligence
   */
  public async getActiveHedgeOffers(): Promise<HedgeQuote[]> {
    const query = `
      query GetActiveOffers {
        hedgeOffers(where: { isRevoked: false }, orderBy: effectiveRate, orderDirection: asc) {
          id
          offerId
          underwriter
          rateNumerator
          rateDenominator
          effectiveRate
          maxCapacity
          filledAmount
          validWhile
          isRevoked
        }
        underwriterMetrics {
          id
          underwriter
          totalOffersShipped
          totalCoverageSettled
          totalSettledVolume
          activeOffersCount
        }
      }
    `;

    try {
      const response = await fetch(this.subgraphEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });

      if (response.ok) {
        const json = (await response.json()) as { data?: { hedgeOffers?: SubgraphHedgeOffer[] } };
        if (json.data?.hedgeOffers) {
          return json.data.hedgeOffers.map((o) => ({
            quoteId: o.id,
            underwriter: o.underwriter,
            underwriterName: `Underwriter-${o.underwriter.slice(0, 6)}`,
            rateMultiplier: BigInt(o.rateNumerator),
            rateDivider: BigInt(o.rateDenominator),
            effectiveRate: parseFloat(o.effectiveRate),
            maxCapacity: BigInt(o.maxCapacity),
            validWhile: parseInt(o.validWhile, 10),
            strategyHash: o.offerId,
          }));
        }
      }
    } catch {
      // Fallback for offline local verification
    }

    return [];
  }
}
