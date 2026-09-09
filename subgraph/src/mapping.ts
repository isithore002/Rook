import { BigInt, BigDecimal } from "@graphprotocol/graph-ts";
import {
  CoverageSettled as CoverageSettledEvent
} from "../generated/RookRegistry/RookRegistry";
import {
  Shipped as ShippedEvent,
  Docked as DockedEvent
} from "../generated/Aqua/Aqua";
import {
  CoverageSettled,
  HedgeOffer,
  UnderwriterMetrics
} from "../generated/schema";

/**
 * Handle on-chain settlement recorded by RookRegistry
 */
export function handleCoverageSettled(event: CoverageSettledEvent): void {
  let id = event.params.txRef.toHexString();
  let settlement = new CoverageSettled(id);

  settlement.txRef = event.params.txRef;
  settlement.underwriter = event.params.underwriter;
  settlement.buyer = event.params.buyer;
  settlement.rate = event.params.rate;
  settlement.size = event.params.size;
  settlement.timestamp = event.params.timestamp;
  settlement.blockNumber = event.block.number;
  settlement.transactionHash = event.transaction.hash;

  settlement.save();

  // Update derived underwriter metrics
  let underwriterId = event.params.underwriter.toHexString();
  let metrics = UnderwriterMetrics.load(underwriterId);

  if (metrics == null) {
    metrics = new UnderwriterMetrics(underwriterId);
    metrics.underwriter = event.params.underwriter;
    metrics.totalOffersShipped = BigInt.fromI32(0);
    metrics.totalCoverageSettled = BigInt.fromI32(0);
    metrics.totalSettledVolume = BigInt.fromI32(0);
    metrics.averageRate = BigDecimal.fromString("1.0");
    metrics.activeOffersCount = BigInt.fromI32(0);
    metrics.lastSettlementTimestamp = BigInt.fromI32(0);
  }

  metrics.totalCoverageSettled = metrics.totalCoverageSettled.plus(BigInt.fromI32(1));
  metrics.totalSettledVolume = metrics.totalSettledVolume.plus(event.params.size);
  metrics.lastSettlementTimestamp = event.block.timestamp;

  metrics.save();
}

/**
 * Handle new hedge offer position shipped on Aqua Core
 */
export function handleShipped(event: ShippedEvent): void {
  let id = event.params.strategyHash.toHexString();
  let offer = new HedgeOffer(id);

  offer.offerId = event.params.strategyHash;
  offer.underwriter = event.params.maker;
  
  if (event.params.tokens.length >= 2) {
    offer.tokenIn = event.params.tokens[0];
    offer.tokenOut = event.params.tokens[1];
  } else {
    offer.tokenIn = event.params.maker;
    offer.tokenOut = event.params.maker;
  }

  offer.rateNumerator = BigInt.fromI32(105);
  offer.rateDenominator = BigInt.fromI32(100);
  offer.effectiveRate = BigDecimal.fromString("1.05");

  if (event.params.amounts.length >= 2) {
    offer.maxCapacity = event.params.amounts[1];
  } else {
    offer.maxCapacity = BigInt.fromI32(0);
  }

  offer.filledAmount = BigInt.fromI32(0);
  offer.validWhile = event.block.timestamp.plus(BigInt.fromI32(86400));
  offer.isRevoked = false;
  offer.blockNumber = event.block.number;
  offer.timestamp = event.block.timestamp;

  offer.save();

  // Update underwriter active count
  let underwriterId = event.params.maker.toHexString();
  let metrics = UnderwriterMetrics.load(underwriterId);
  if (metrics == null) {
    metrics = new UnderwriterMetrics(underwriterId);
    metrics.underwriter = event.params.maker;
    metrics.totalOffersShipped = BigInt.fromI32(0);
    metrics.totalCoverageSettled = BigInt.fromI32(0);
    metrics.totalSettledVolume = BigInt.fromI32(0);
    metrics.averageRate = BigDecimal.fromString("1.05");
    metrics.activeOffersCount = BigInt.fromI32(0);
    metrics.lastSettlementTimestamp = BigInt.fromI32(0);
  }

  metrics.totalOffersShipped = metrics.totalOffersShipped.plus(BigInt.fromI32(1));
  metrics.activeOffersCount = metrics.activeOffersCount.plus(BigInt.fromI32(1));
  metrics.save();
}

/**
 * Handle hedge offer cancellation / docking on Aqua Core
 */
export function handleDocked(event: DockedEvent): void {
  let id = event.params.strategyHash.toHexString();
  let offer = HedgeOffer.load(id);

  if (offer != null) {
    offer.isRevoked = true;
    offer.save();

    let underwriterId = event.params.maker.toHexString();
    let metrics = UnderwriterMetrics.load(underwriterId);
    if (metrics != null && metrics.activeOffersCount.gt(BigInt.fromI32(0))) {
      metrics.activeOffersCount = metrics.activeOffersCount.minus(BigInt.fromI32(1));
      metrics.save();
    }
  }
}
