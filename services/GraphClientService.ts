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

export interface SubgraphUnderwriterProfile {
  underwriter: string;
  totalOffersShipped: string;
  totalOffersRepriced: string;
  totalOffersCancelled: string;
  totalCoverageSettled: string;
  totalSettledVolume: string;
  averageSpreadBps: string;
  fillReliabilityScore: string;
  reputationTier: string;
  activeOffersCount: string;
  lastSettlementTimestamp: string;
}

/**
 * GraphClientService
 * Queries The Graph Subgraph endpoint for live HedgeOffers and derived UnderwriterExecutionProfiles.
 * Derives intelligent quote filtering based on underwriter reliability and execution history.
 */
export class GraphClientService {
  private readonly subgraphEndpoint: string;

  constructor(endpoint = "http://localhost:8000/subgraphs/name/rook/rook-protocol") {
    this.subgraphEndpoint = endpoint;
  }

  /**
   * GraphQL Query to retrieve active hedge offers and underwriter execution profiles
   * Filters out unreliable underwriters based on derived Graph intelligence.
   */
  public async getVettedActiveOffers(minReliabilityScore = 0.5): Promise<HedgeQuote[]> {
    const query = `
      query GetVettedOffers {
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
        underwriterExecutionProfiles {
          id
          underwriter
          totalOffersShipped
          totalOffersRepriced
          totalOffersCancelled
          totalCoverageSettled
          totalSettledVolume
          fillReliabilityScore
          reputationTier
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
        const json = (await response.json()) as {
          data?: {
            hedgeOffers?: SubgraphHedgeOffer[];
            underwriterExecutionProfiles?: SubgraphUnderwriterProfile[];
          };
        };

        const profiles = new Map<string, SubgraphUnderwriterProfile>();
        if (json.data?.underwriterExecutionProfiles) {
          for (const p of json.data.underwriterExecutionProfiles) {
            profiles.set(p.underwriter.toLowerCase(), p);
          }
        }

        if (json.data?.hedgeOffers) {
          return json.data.hedgeOffers
            .filter((o) => {
              const p = profiles.get(o.underwriter.toLowerCase());
              // If underwriter has a profile, ensure reliability exceeds threshold
              if (p) {
                const score = parseFloat(p.fillReliabilityScore);
                return score >= minReliabilityScore;
              }
              return true; // New underwriter with baseline allowance
            })
            .map((o) => ({
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
