/**
 * Core type definitions for Rook agents, risk scoring, and hedge offers.
 */

export interface ProposedTransaction {
  txRef: string;
  sender: string;
  target: string;
  asset: string;
  amount: bigint;
  description: string;
  metadata?: {
    isContract?: boolean;
    contractVerified?: boolean;
    ageDays?: number;
    priorTransfers?: number;
    [key: string]: unknown;
  };
}

export interface RiskResult {
  riskScore: number; // 0 - 100
  hardBlock: boolean; // strictly deterministic
  requiresHedge: boolean; // true if riskScore >= threshold and !hardBlock
  reasoning: string;
}

export interface HedgeQuote {
  quoteId: string;
  underwriter: string;
  underwriterName: string;
  rateMultiplier: bigint; // e.g. 105
  rateDivider: bigint;    // e.g. 100 (represents 1.05 RISK for 1 SAFE)
  effectiveRate: number;  // 1.05
  maxCapacity: bigint;
  validWhile: number;     // timestamp
  strategyHash?: string;
}

export interface HedgeExecutionResult {
  success: boolean;
  txRef: string;
  underwriter: string;
  effectiveRate: number;
  amountHedged: bigint;
  amountSafeReceived: bigint;
  orderHash?: string;
  registryRecordConfirmed: boolean;
  reason?: string;
}
