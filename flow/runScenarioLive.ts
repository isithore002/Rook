/**
 * Live scenario runner — the composition layer that makes the Rook agents act
 * on a real chain. Risk scoring -> each underwriter ships a real RevocableRateOffer
 * position on Aqua -> ActingAgent vets (Graph profiles) and selects -> the winner's
 * offer is filled atomically through AgentHedgeExecutor -> settlement is read back
 * from RookRegistry. Every on-chain step returns a real transaction hash.
 */
import { keccak256, encodePacked, type Address, type Hex } from "viem";
import type { ProposedTransaction, RiskResult, HedgeQuote } from "../agents/types.ts";
import type { RiskScoringService } from "../services/RiskScoringService.ts";
import type { UnderwriterAgent } from "../agents/UnderwriterAgent.ts";
import type { ActingAgent } from "../agents/ActingAgent.ts";
import { RookChain } from "../chain/rookChain.ts";

export type LiveOutcome =
  | "PROCEEDED_UNHEDGED"
  | "HEDGED_AND_SETTLED"
  | "HARD_BLOCKED"
  | "BLOCKED_NO_QUOTE";

export interface ShippedOffer {
  underwriter: Address;
  name: string;
  effectiveRate: number;
  offerId: Hex;
  strategyHash: Hex;
  shipTxHash: Hex;
}

export interface LiveScenarioTrace {
  label: string;
  txRef: Hex;
  risk: { score: number; hardBlock: boolean; requiresHedge: boolean };
  shipped: ShippedOffer[];
  disqualified: { name: string; reason: string }[];
  marketEvents: string[];
  selected?: { name: string; effectiveRate: number; offerId: Hex };
  execution?: {
    txHash: Hex;
    blockNumber: string;
    safeAmountOut: string;
    coverageRecorded: boolean;
  };
  outcome: LiveOutcome;
}

function offerIdFor(underwriter: Address, txRef: Hex): Hex {
  return keccak256(encodePacked(["address", "bytes32"], [underwriter, txRef]));
}

export interface RunScenarioOpts {
  chain: RookChain;
  riskService: RiskScoringService;
  underwriters: UnderwriterAgent[];
  actingAgent: ActingAgent;
  tx: ProposedTransaction;
  label: string;
  /** Risky-path target the acting agent calls once hedged. Defaults to the deployment's demoTarget. */
  target?: Address;
  targetUnits?: bigint;
  /** When true, show a live reprice + cancel by the non-winning underwriters. */
  showMarketDynamics?: boolean;
}

export async function runScenarioLive(opts: RunScenarioOpts): Promise<LiveScenarioTrace> {
  const { chain, riskService, underwriters, actingAgent, tx, label } = opts;
  const txRef = tx.txRef as Hex;
  const risk: RiskResult = await riskService.scoreTransaction(tx);

  const trace: LiveScenarioTrace = {
    label,
    txRef,
    risk: { score: risk.riskScore, hardBlock: risk.hardBlock, requiresHedge: risk.requiresHedge },
    shipped: [],
    disqualified: [],
    marketEvents: [],
    outcome: "PROCEEDED_UNHEDGED",
  };

  if (risk.hardBlock) {
    trace.outcome = "HARD_BLOCKED";
    return trace;
  }
  if (!risk.requiresHedge) {
    trace.outcome = "PROCEEDED_UNHEDGED";
    return trace;
  }

  // 1. Every underwriter with enough capacity ships a real position.
  // Hour-snapped expiry so back-to-back demo runs are byte-reproducible.
  const validWhile = await chain.validWhile(1);
  const shippedByUw = new Map<string, { offer: ShippedOffer; quote: HedgeQuote }>();
  for (const uw of underwriters) {
    const quote = uw.generateQuote(tx, risk);
    if (!quote || quote.maxCapacity < tx.amount) continue;
    const offerId = offerIdFor(uw.address as Address, txRef);
    const ship = await chain.shipOffer(
      uw.address as Address,
      offerId,
      quote.rateMultiplier,
      quote.rateDivider,
      quote.maxCapacity,
      validWhile,
    );
    const offer: ShippedOffer = {
      underwriter: uw.address as Address,
      name: uw.name,
      effectiveRate: quote.effectiveRate,
      offerId,
      strategyHash: ship.strategyHash,
      shipTxHash: ship.txHash,
    };
    trace.shipped.push(offer);
    shippedByUw.set(uw.address.toLowerCase(), { offer, quote });
  }

  // 2. ActingAgent vets (Graph execution profiles) and selects the best rate.
  const plan = await actingAgent.evaluateAndPlan(tx);
  trace.disqualified = (plan.disqualifiedQuotes ?? []).map((d) => ({
    name: d.quote.underwriterName,
    reason: d.reason,
  }));

  if (plan.blocked || !plan.selectedQuote) {
    trace.outcome = "BLOCKED_NO_QUOTE";
    return trace;
  }

  const winner = shippedByUw.get(plan.selectedQuote.underwriter.toLowerCase());
  if (!winner) {
    // Selected underwriter never shipped on-chain (capacity/profile mismatch) — fail closed.
    trace.outcome = "BLOCKED_NO_QUOTE";
    return trace;
  }
  trace.selected = {
    name: winner.offer.name,
    effectiveRate: winner.offer.effectiveRate,
    offerId: winner.offer.offerId,
  };

  // 3. Optional: show the market repricing/cancelling around the winner.
  if (opts.showMarketDynamics) {
    for (const { offer, quote } of shippedByUw.values()) {
      if (offer.underwriter.toLowerCase() === winner.offer.underwriter.toLowerCase()) continue;
      if (trace.marketEvents.length === 0) {
        const nIn = quote.rateMultiplier + 3n;
        await chain.repriceOffer(offer.underwriter, offer.offerId, nIn, quote.rateDivider);
        trace.marketEvents.push(`${offer.name} repriced ${offer.effectiveRate}:1 -> ${Number(nIn) / Number(quote.rateDivider)}:1`);
      } else {
        await chain.cancelOffer(offer.underwriter, offer.offerId);
        trace.marketEvents.push(`${offer.name} cancelled its offer`);
      }
    }
  }

  // 4. Fill the winning offer atomically via the executor, then read settlement back.
  const rebuilt = await chain.buildOrder(
    winner.offer.underwriter,
    winner.offer.offerId,
    winner.quote.rateMultiplier,
    winner.quote.rateDivider,
    winner.quote.maxCapacity,
    validWhile,
  );
  const swapAmountIn = (tx.amount * winner.quote.rateMultiplier) / winner.quote.rateDivider;
  const expectedHedgeRate = (winner.quote.rateMultiplier * 10n ** 18n) / winner.quote.rateDivider;
  const target = opts.target ?? chain.d.demoTarget;
  const targetCalldata =
    target && target !== "0x0000000000000000000000000000000000000000"
      ? RookChain.encodeArbitrageCall(opts.targetUnits ?? 1n)
      : ("0x" as Hex);

  const fill = await chain.executeProtected({
    caller: actingAgent.address as Address,
    txRef,
    order: rebuilt.order,
    swapAmountIn,
    expectedHedgeRate,
    target,
    targetCalldata,
  });

  trace.execution = {
    txHash: fill.txHash,
    blockNumber: fill.blockNumber.toString(),
    safeAmountOut: fill.safeAmountOut.toString(),
    coverageRecorded: fill.coverageRecorded,
  };
  trace.outcome = fill.coverageRecorded ? "HEDGED_AND_SETTLED" : "BLOCKED_NO_QUOTE";
  return trace;
}
