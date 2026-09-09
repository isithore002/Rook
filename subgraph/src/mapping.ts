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
  UnderwriterExecutionProfile
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

  // Update derived underwriter execution profile
  let underwriterId = event.params.underwriter.toHexString();
  let profile = UnderwriterExecutionProfile.load(underwriterId);

  if (profile == null) {
    profile = new UnderwriterExecutionProfile(underwriterId);
    profile.underwriter = event.params.underwriter;
    profile.totalOffersShipped = BigInt.fromI32(0);
    profile.totalOffersRepriced = BigInt.fromI32(0);
    profile.totalOffersCancelled = BigInt.fromI32(0);
    profile.totalCoverageSettled = BigInt.fromI32(0);
    profile.totalSettledVolume = BigInt.fromI32(0);
    profile.averageSpreadBps = BigInt.fromI32(500); // 5% base
    profile.fillReliabilityScore = BigDecimal.fromString("1.0");
    profile.reputationTier = "TIER_1_PRIME";
    profile.activeOffersCount = BigInt.fromI32(0);
    profile.lastSettlementTimestamp = BigInt.fromI32(0);
    profile.lastActiveBlock = event.block.number;
  }

  profile.totalCoverageSettled = profile.totalCoverageSettled.plus(BigInt.fromI32(1));
  profile.totalSettledVolume = profile.totalSettledVolume.plus(event.params.size);
  profile.lastSettlementTimestamp = event.block.timestamp;
  profile.lastActiveBlock = event.block.number;

  // Derive reliability: settled / (settled + cancelled)
  let totalResolved = profile.totalCoverageSettled.plus(profile.totalOffersCancelled);
  if (totalResolved.gt(BigInt.fromI32(0))) {
    let settledDec = profile.totalCoverageSettled.toBigDecimal();
    let totalDec = totalResolved.toBigDecimal();
    profile.fillReliabilityScore = settledDec.div(totalDec);

    if (profile.fillReliabilityScore.ge(BigDecimal.fromString("0.75"))) {
      profile.reputationTier = "TIER_1_PRIME";
    } else if (profile.fillReliabilityScore.ge(BigDecimal.fromString("0.40"))) {
      profile.reputationTier = "TIER_2_STANDARD";
    } else {
      profile.reputationTier = "TIER_3_VOLATILE";
    }
  }

  profile.save();
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

  // Update underwriter active count & offer count
  let underwriterId = event.params.maker.toHexString();
  let profile = UnderwriterExecutionProfile.load(underwriterId);
  if (profile == null) {
    profile = new UnderwriterExecutionProfile(underwriterId);
    profile.underwriter = event.params.maker;
    profile.totalOffersShipped = BigInt.fromI32(0);
    profile.totalOffersRepriced = BigInt.fromI32(0);
    profile.totalOffersCancelled = BigInt.fromI32(0);
    profile.totalCoverageSettled = BigInt.fromI32(0);
    profile.totalSettledVolume = BigInt.fromI32(0);
    profile.averageSpreadBps = BigInt.fromI32(500);
    profile.fillReliabilityScore = BigDecimal.fromString("1.0");
    profile.reputationTier = "TIER_1_PRIME";
    profile.activeOffersCount = BigInt.fromI32(0);
    profile.lastSettlementTimestamp = BigInt.fromI32(0);
    profile.lastActiveBlock = event.block.number;
  }

  profile.totalOffersShipped = profile.totalOffersShipped.plus(BigInt.fromI32(1));
  profile.activeOffersCount = profile.activeOffersCount.plus(BigInt.fromI32(1));
  profile.lastActiveBlock = event.block.number;
  profile.save();
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
    let profile = UnderwriterExecutionProfile.load(underwriterId);
    if (profile != null) {
      profile.totalOffersCancelled = profile.totalOffersCancelled.plus(BigInt.fromI32(1));
      if (profile.activeOffersCount.gt(BigInt.fromI32(0))) {
        profile.activeOffersCount = profile.activeOffersCount.minus(BigInt.fromI32(1));
      }
      profile.lastActiveBlock = event.block.number;

      // Recompute reliability
      let totalResolved = profile.totalCoverageSettled.plus(profile.totalOffersCancelled);
      if (totalResolved.gt(BigInt.fromI32(0))) {
        let settledDec = profile.totalCoverageSettled.toBigDecimal();
        let totalDec = totalResolved.toBigDecimal();
        profile.fillReliabilityScore = settledDec.div(totalDec);

        if (profile.fillReliabilityScore.ge(BigDecimal.fromString("0.75"))) {
          profile.reputationTier = "TIER_1_PRIME";
        } else if (profile.fillReliabilityScore.ge(BigDecimal.fromString("0.40"))) {
          profile.reputationTier = "TIER_2_STANDARD";
        } else {
          profile.reputationTier = "TIER_3_VOLATILE";
        }
      }

      profile.save();
    }
  }
}
