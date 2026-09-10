import { Address, BigDecimal, BigInt } from "@graphprotocol/graph-ts";
import { CoverageSettled as CoverageSettledEvent } from "../generated/RookRegistry/RookRegistry";
import { Shipped as ShippedEvent, Docked as DockedEvent } from "../generated/Aqua/Aqua";
import {
  OfferRepriced as OfferRepricedEvent,
  OfferRevoked as OfferRevokedEvent,
} from "../generated/SwapVMRouter/SwapVMRouter";
import { CoverageSettled, HedgeOffer, UnderwriterExecutionProfile } from "../generated/schema";

const ONE_E18 = BigInt.fromString("1000000000000000000");
const ONE_E14 = BigInt.fromString("100000000000000");

function loadOrCreateProfile(underwriter: Address, block: BigInt): UnderwriterExecutionProfile {
  let id = underwriter.toHexString();
  let p = UnderwriterExecutionProfile.load(id);
  if (p == null) {
    p = new UnderwriterExecutionProfile(id);
    p.underwriter = underwriter;
    p.totalOffersShipped = BigInt.zero();
    p.totalOffersRepriced = BigInt.zero();
    p.totalOffersCancelled = BigInt.zero();
    p.totalCoverageSettled = BigInt.zero();
    p.totalSettledVolume = BigInt.zero();
    p.averageSpreadBps = BigInt.zero();
    p.fillReliabilityScore = BigDecimal.fromString("1");
    p.reputationTier = "TIER_1_PRIME";
    p.activeOffersCount = BigInt.zero();
    p.lastSettlementTimestamp = BigInt.zero();
    p.lastActiveBlock = block;
  }
  return p;
}

/** reliability = settled / (settled + cancelled); default 1.0 when nothing is resolved yet. */
function recomputeReliability(p: UnderwriterExecutionProfile): void {
  let resolved = p.totalCoverageSettled.plus(p.totalOffersCancelled);
  if (resolved.gt(BigInt.zero())) {
    p.fillReliabilityScore = p.totalCoverageSettled.toBigDecimal().div(resolved.toBigDecimal());
  }
  if (p.fillReliabilityScore.ge(BigDecimal.fromString("0.75"))) {
    p.reputationTier = "TIER_1_PRIME";
  } else if (p.fillReliabilityScore.ge(BigDecimal.fromString("0.40"))) {
    p.reputationTier = "TIER_2_STANDARD";
  } else {
    p.reputationTier = "TIER_3_VOLATILE";
  }
}

/**
 * Aqua `Shipped(address maker, address app, bytes32 strategyHash, bytes strategy)`.
 * The event carries only the abi-encoded strategy blob — the RevocableRateOffer
 * rate/size live inside `strategy.data` behind the SwapVM instruction encoding,
 * so offer economics are tracked from `OfferRepriced` and `CoverageSettled.rate`
 * (see `services/RookIndexer.ts`, the Docker-free reference implementation).
 */
export function handleShipped(event: ShippedEvent): void {
  let id = event.params.strategyHash.toHexString();
  let offer = new HedgeOffer(id);
  offer.offerId = event.params.strategyHash;
  offer.underwriter = event.params.maker;
  offer.tokenIn = event.params.maker;
  offer.tokenOut = event.params.maker;
  offer.rateNumerator = BigInt.zero();
  offer.rateDenominator = BigInt.zero();
  offer.effectiveRate = BigDecimal.zero();
  offer.maxCapacity = BigInt.zero();
  offer.filledAmount = BigInt.zero();
  offer.validWhile = BigInt.zero();
  offer.isRevoked = false;
  offer.blockNumber = event.block.number;
  offer.timestamp = event.block.timestamp;
  offer.save();

  let p = loadOrCreateProfile(event.params.maker, event.block.number);
  p.totalOffersShipped = p.totalOffersShipped.plus(BigInt.fromI32(1));
  p.activeOffersCount = p.activeOffersCount.plus(BigInt.fromI32(1));
  p.lastActiveBlock = event.block.number;
  p.save();
}

/** Aqua-level dock: mark the position revoked. Cancellation *accounting* is owned
 *  by `handleOfferRevoked` (the opcode-level signal) to avoid double counting. */
export function handleDocked(event: DockedEvent): void {
  let offer = HedgeOffer.load(event.params.strategyHash.toHexString());
  if (offer != null) {
    offer.isRevoked = true;
    offer.save();
  }
}

/** SwapVM `OfferRevoked(indexed address maker, indexed bytes32 offerId)` — the
 *  authoritative cancellation signal for the reliability score. */
export function handleOfferRevoked(event: OfferRevokedEvent): void {
  let p = loadOrCreateProfile(event.params.maker, event.block.number);
  p.totalOffersCancelled = p.totalOffersCancelled.plus(BigInt.fromI32(1));
  if (p.activeOffersCount.gt(BigInt.zero())) {
    p.activeOffersCount = p.activeOffersCount.minus(BigInt.fromI32(1));
  }
  p.lastActiveBlock = event.block.number;
  recomputeReliability(p);
  p.save();
}

/** SwapVM `OfferRepriced(indexed address maker, indexed bytes32 offerId, uint64, uint64)`. */
export function handleOfferRepriced(event: OfferRepricedEvent): void {
  let p = loadOrCreateProfile(event.params.maker, event.block.number);
  p.totalOffersRepriced = p.totalOffersRepriced.plus(BigInt.fromI32(1));
  p.lastActiveBlock = event.block.number;
  p.save();
}

/** RookRegistry `CoverageSettled(indexed bytes32 txRef, indexed address underwriter,
 *  indexed address buyer, uint256 rate, uint256 size, uint256 timestamp)`. */
export function handleCoverageSettled(event: CoverageSettledEvent): void {
  let settlement = new CoverageSettled(event.params.txRef.toHexString());
  settlement.txRef = event.params.txRef;
  settlement.underwriter = event.params.underwriter;
  settlement.buyer = event.params.buyer;
  settlement.rate = event.params.rate;
  settlement.size = event.params.size;
  settlement.timestamp = event.params.timestamp;
  settlement.blockNumber = event.block.number;
  settlement.transactionHash = event.transaction.hash;
  settlement.save();

  let p = loadOrCreateProfile(event.params.underwriter, event.block.number);
  p.totalCoverageSettled = p.totalCoverageSettled.plus(BigInt.fromI32(1));
  p.totalSettledVolume = p.totalSettledVolume.plus(event.params.size);
  p.lastSettlementTimestamp = event.params.timestamp;
  p.lastActiveBlock = event.block.number;
  if (p.activeOffersCount.gt(BigInt.zero())) {
    p.activeOffersCount = p.activeOffersCount.minus(BigInt.fromI32(1));
  }

  // Rolling average realized spread, in bps: ((rate / 1e14) - 1e4) per settlement.
  let spreadBps = event.params.rate.div(ONE_E14).minus(BigInt.fromI32(10000));
  if (spreadBps.lt(BigInt.zero())) {
    spreadBps = BigInt.zero();
  }
  let n = p.totalCoverageSettled;
  p.averageSpreadBps = p.averageSpreadBps.times(n.minus(BigInt.fromI32(1))).plus(spreadBps).div(n);

  recomputeReliability(p);
  p.save();
}
