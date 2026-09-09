import type { HedgeQuote, ProposedTransaction, RiskResult } from "./types.ts";
import { RiskScoringService } from "../services/RiskScoringService.ts";
import { UnderwriterAgent } from "./UnderwriterAgent.ts";

export interface ActingAgentExecutionPlan {
  txRef: string;
  proceeded: boolean;
  blocked: boolean;
  hedged: boolean;
  riskResult: RiskResult;
  selectedQuote?: HedgeQuote;
  competingQuotes?: HedgeQuote[];
  message: string;
}

/**
 * Acting Agent
 * Evaluates proposed transactions, solicits competitive quotes if risky,
 * selects the optimal hedge quote, and coordinates settlement.
 */
export class ActingAgent {
  public readonly address: string;
  private readonly riskService: RiskScoringService;
  private readonly underwriters: UnderwriterAgent[];

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
   * Process a proposed transaction through the Rook risk & hedging pipeline
   * @param tx Proposed transaction
   * @returns Complete execution plan
   */
  public async evaluateAndPlan(tx: ProposedTransaction): Promise<ActingAgentExecutionPlan> {
    const riskResult = await this.riskService.scoreTransaction(tx);

    // 1. HARD BLOCK CHECK
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
    const quotes: HedgeQuote[] = [];
    for (const uw of this.underwriters) {
      const quote = uw.generateQuote(tx, riskResult);
      if (quote && quote.maxCapacity >= tx.amount) {
        quotes.push(quote);
      }
    }

    // If no underwriters quoted or capacity is insufficient
    if (quotes.length === 0) {
      return {
        txRef: tx.txRef,
        proceeded: false,
        blocked: true,
        hedged: false,
        riskResult,
        message: "Transaction BLOCKED: No underwriter willing to provide required coverage capacity.",
      };
    }

    // 4. SELECT BEST QUOTE (Lowest effective rate)
    quotes.sort((a, b) => a.effectiveRate - b.effectiveRate);
    const bestQuote = quotes[0];

    return {
      txRef: tx.txRef,
      proceeded: true,
      blocked: false,
      hedged: true,
      riskResult,
      selectedQuote: bestQuote,
      competingQuotes: quotes,
      message: `Hedge REQUIRED. Selected best quote from ${bestQuote.underwriterName} at rate ${bestQuote.effectiveRate}:1.`,
    };
  }
}
