import type { HedgeQuote, ProposedTransaction, RiskResult } from "./types.ts";
import { RiskScoringService } from "../services/RiskScoringService.ts";
import { UnderwriterAgent } from "./UnderwriterAgent.ts";
import type { SubgraphUnderwriterProfile } from "../services/GraphClientService.ts";

export interface ActingAgentExecutionPlan {
  txRef: string;
  proceeded: boolean;
  blocked: boolean;
  hedged: boolean;
  riskResult: RiskResult;
  selectedQuote?: HedgeQuote;
  competingQuotes?: HedgeQuote[];
  disqualifiedQuotes?: Array<{ quote: HedgeQuote; reason: string }>;
  message: string;
}

/**
 * Acting Agent
 * Evaluates proposed transactions, solicits competitive quotes if risky,
 * filters quotes by Graph-derived underwriter reliability, selects the optimal hedge,
 * and coordinates protected execution.
 */
export class ActingAgent {
  public readonly address: string;
  private readonly riskService: RiskScoringService;
  private readonly underwriters: UnderwriterAgent[];
  private readonly underwriterProfiles: Map<string, SubgraphUnderwriterProfile> = new Map();

  constructor(
    address: string,
    riskService: RiskScoringService,
    underwriters: UnderwriterAgent[]
  ) {
    this.address = address;
    this.riskService = riskService;
    this.underwriters = underwriters;
  }

  /**
   * Ingest Graph-derived underwriter execution profiles
   * @param address Underwriter address
   * @param profile Underwriter execution intelligence from The Graph
   */
  public setUnderwriterProfile(address: string, profile: SubgraphUnderwriterProfile): void {
    this.underwriterProfiles.set(address.toLowerCase(), profile);
  }

  /**
   * Process a proposed transaction through the Rook risk & hedging pipeline
   * @param tx Proposed transaction
   * @returns Complete execution plan
   */
  public async evaluateAndPlan(tx: ProposedTransaction): Promise<ActingAgentExecutionPlan> {
    const riskResult = await this.riskService.scoreTransaction(tx);

    // 1. HARD BLOCK CHECK (Invariant 10: Fails Closed)
    if (riskResult.hardBlock) {
      return {
        txRef: tx.txRef,
        proceeded: false,
        blocked: true,
        hedged: false,
        riskResult,
        message: `Transaction BLOCKED: ${riskResult.reasoning}`,
      };
    }

    // 2. SAFE TRANSACTION (No hedge required)
    if (!riskResult.requiresHedge) {
      return {
        txRef: tx.txRef,
        proceeded: true,
        blocked: false,
        hedged: false,
        riskResult,
        message: "Transaction is SAFE (risk below threshold). Proceeded directly without hedge.",
      };
    }

    // 3. RISKY TRANSACTION: SOLICIT COMPETITIVE HEDGE QUOTES
    const rawQuotes: HedgeQuote[] = [];
    for (const uw of this.underwriters) {
      const quote = uw.generateQuote(tx, riskResult);
      if (quote && quote.maxCapacity >= tx.amount) {
        rawQuotes.push(quote);
      }
    }

    // 4. GRAPH INTELLIGENCE VETTING (Invariant 7)
    // Filter quotes using Graph-derived execution profiles
    const vettedQuotes: HedgeQuote[] = [];
    const disqualifiedQuotes: Array<{ quote: HedgeQuote; reason: string }> = [];

    for (const q of rawQuotes) {
      const profile = this.underwriterProfiles.get(q.underwriter.toLowerCase());
      if (profile) {
        const score = parseFloat(profile.fillReliabilityScore);
        if (score < 0.60 || profile.reputationTier === "TIER_3_VOLATILE") {
          disqualifiedQuotes.push({
            quote: q,
            reason: `Disqualified by Graph execution profile: Reliability ${profile.fillReliabilityScore}% (Tier: ${profile.reputationTier})`,
          });
          continue;
        }
      }
      vettedQuotes.push(q);
    }

    // If no underwriters quoted or capacity is insufficient
    if (vettedQuotes.length === 0) {
      return {
        txRef: tx.txRef,
        proceeded: false,
        blocked: true,
        hedged: false,
        riskResult,
        disqualifiedQuotes,
        message: "Transaction BLOCKED: No vetted underwriter with required capacity and reliability.",
      };
    }

    // 5. SELECT BEST QUOTE (Lowest effective rate among vetted underwriters)
    vettedQuotes.sort((a, b) => a.effectiveRate - b.effectiveRate);
    const bestQuote = vettedQuotes[0];

    return {
      txRef: tx.txRef,
      proceeded: true,
      blocked: false,
      hedged: true,
      riskResult,
      selectedQuote: bestQuote,
      competingQuotes: vettedQuotes,
      disqualifiedQuotes,
      message: `Hedge REQUIRED. Selected best quote from ${bestQuote.underwriterName} at rate ${bestQuote.effectiveRate}:1.`,
    };
  }
}
