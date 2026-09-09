import type { ProposedTransaction, RiskResult } from "../agents/types.ts";

/**
 * Risk-Scoring Service
 * Combines a deterministic rules engine (sole authority for hard blocks and baseline score)
 * with a bounded LLM advisory layer that evaluates transaction descriptions and intent.
 */
export class RiskScoringService {
  private readonly RISK_THRESHOLD = 50;

  // Known blacklisted / malicious / sanctioned addresses
  private readonly BLACKLISTED_ADDRESSES = new Set<string>([
    "0x000000000000000000000000000000000000dead".toLowerCase(),
    "0x0000000000000000000000000000000000000000".toLowerCase(),
    "0xba12222222228d8ba445958a75a0704d566bf2c8".toLowerCase(), // example sanctioned/flagged
  ]);

  // Known trusted treasury / safe multisig addresses
  private readonly TRUSTED_ADDRESSES = new Set<string>([
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8".toLowerCase(),
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266".toLowerCase(),
  ]);

  /**
   * Score a proposed transaction
   * @param tx Proposed transaction details
   * @returns Risk evaluation result
   */
  public async scoreTransaction(tx: ProposedTransaction): Promise<RiskResult> {
    // 1. DETERMINISTIC RULES EVALUATION (Authority Layer)
    const normalizedTarget = tx.target.toLowerCase();

    // Check hard block
    if (this.BLACKLISTED_ADDRESSES.has(normalizedTarget)) {
      return {
        riskScore: 100,
        hardBlock: true,
        requiresHedge: false,
        reasoning: `DETERMINISTIC HARD BLOCK: Target ${tx.target} is an identified exploit/sanctioned address.`,
      };
    }

    let deterministicScore = 10;
    const reasons: string[] = [];

    // Check trusted whitelist
    if (this.TRUSTED_ADDRESSES.has(normalizedTarget)) {
      deterministicScore = 15;
      reasons.push("Target is a pre-approved trusted treasury address.");
    } else {
      // Amount thresholds (assuming 18 decimals)
      const amountUnits = Number(tx.amount / 10n ** 18n);
      if (amountUnits >= 10000) {
        deterministicScore += 40;
        reasons.push(`High transfer value (${amountUnits.toLocaleString()} units).`);
      } else if (amountUnits >= 1000) {
        deterministicScore += 25;
        reasons.push(`Significant transfer value (${amountUnits.toLocaleString()} units).`);
      }

      // Metadata checks
      if (tx.metadata) {
        if (tx.metadata.isContract && !tx.metadata.contractVerified) {
          deterministicScore += 30;
          reasons.push("Interacting with an unverified smart contract.");
        }
        if (tx.metadata.ageDays !== undefined && tx.metadata.ageDays < 7) {
          deterministicScore += 15;
          reasons.push(`Newly deployed contract (${tx.metadata.ageDays} days old).`);
        }
        if (tx.metadata.priorTransfers !== undefined && tx.metadata.priorTransfers === 0) {
          deterministicScore += 10;
          reasons.push("Zero historical transfer history with counterparty.");
        }
      }
    }

    deterministicScore = Math.min(Math.max(deterministicScore, 0), 95);

    // 2. BOUNDED ADVISORY LAYER (LLM / Context Evaluator)
    const advisory = await this.evaluateAdvisoryNotes(tx, deterministicScore);

    // Bounded adjustment: LLM may adjust score by at most +/- 10 points
    let finalScore = deterministicScore + advisory.scoreAdjustment;
    finalScore = Math.min(Math.max(finalScore, 0), 95);

    const combinedReasoning = [
      ...reasons,
      `Advisory note: ${advisory.notes}`,
    ].join(" ");

    const requiresHedge = finalScore >= this.RISK_THRESHOLD;

    return {
      riskScore: finalScore,
      hardBlock: false,
      requiresHedge,
      reasoning: combinedReasoning,
    };
  }

  /**
   * Bounded advisory evaluator.
   * Examines narrative description and keywords.
   */
  private async evaluateAdvisoryNotes(
    tx: ProposedTransaction,
    baselineScore: number
  ): Promise<{ scoreAdjustment: number; notes: string }> {
    const desc = (tx.description || "").toLowerCase();

    // Narrative indicators
    if (desc.includes("arbitrage") || desc.includes("flash") || desc.includes("liquidat")) {
      return {
        scoreAdjustment: 5,
        notes: "Complex DeFi / arbitrage activity flagged with potential MEV slippage risk.",
      };
    }

    if (desc.includes("routine") || desc.includes("rebalance") || desc.includes("internal")) {
      return {
        scoreAdjustment: -5,
        notes: "Standard internal rebalancing activity consistent with normal operations.",
      };
    }

    return {
      scoreAdjustment: 0,
      notes: "Standard transaction intent evaluated without anomalous narrative indicators.",
    };
  }
}
