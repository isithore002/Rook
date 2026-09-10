/**
 * RookIndexer — a local, Docker-free stand-in for the deployed subgraph. It
 * reads the same on-chain events (`Shipped`, `OfferRepriced`, `OfferRevoked`,
 * `CoverageSettled`) and applies the *same* derivation as
 * `subgraph/src/mapping.ts`, producing `UnderwriterExecutionProfile` records in
 * the exact shape `GraphClientService` / `ActingAgent` consume.
 *
 * The real `subgraph/` manifest + schema + mapping remain the deployment
 * artifact for an environment with `graph-node` (Docker or CI). This class lets
 * `npm run e2e` derive underwriter intelligence from real indexed history
 * instead of a hand-written profile literal.
 */
import { decodeEventLog, type Address, type Hex, type PublicClient } from "viem";
import { aquaAbi, registryAbi, routerAbi } from "../chain/abis.ts";
import type { Deployment } from "../chain/config.ts";
import type { SubgraphUnderwriterProfile } from "./GraphClientService.ts";

interface MutProfile {
  underwriter: Address;
  totalOffersShipped: number;
  totalOffersRepriced: number;
  totalOffersCancelled: number;
  totalCoverageSettled: number;
  totalSettledVolume: bigint;
  settledRateBpsSum: number;
  activeOffersCount: number;
  lastSettlementTimestamp: number;
}

function reputationTier(reliability: number): string {
  if (reliability >= 0.75) return "TIER_1_PRIME";
  if (reliability >= 0.4) return "TIER_2_STANDARD";
  return "TIER_3_VOLATILE";
}

export class RookIndexer {
  private readonly pub: PublicClient;
  private readonly d: Deployment;
  private readonly profiles = new Map<string, MutProfile>();

  constructor(pub: PublicClient, d: Deployment) {
    this.pub = pub;
    this.d = d;
  }

  private profile(addr: Address): MutProfile {
    const key = addr.toLowerCase();
    let p = this.profiles.get(key);
    if (!p) {
      p = {
        underwriter: addr,
        totalOffersShipped: 0,
        totalOffersRepriced: 0,
        totalOffersCancelled: 0,
        totalCoverageSettled: 0,
        totalSettledVolume: 0n,
        settledRateBpsSum: 0,
        activeOffersCount: 0,
        lastSettlementTimestamp: 0,
      };
      this.profiles.set(key, p);
    }
    return p;
  }

  /** Replay all relevant logs from `fromBlock` to head and fold them into profiles. */
  async sync(fromBlock: bigint = 0n): Promise<void> {
    this.profiles.clear();
    const toBlock = await this.pub.getBlockNumber();

    const raw = await this.pub.getLogs({ fromBlock, toBlock });
    // Sort by (blockNumber, logIndex) so counts fold in on-chain order.
    raw.sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? (a.logIndex ?? 0) - (b.logIndex ?? 0)
        : Number(a.blockNumber - b.blockNumber),
    );

    const aqua = this.d.aqua.toLowerCase();
    const router = this.d.router.toLowerCase();
    const registry = this.d.registry.toLowerCase();

    for (const log of raw) {
      const addr = log.address.toLowerCase();
      try {
        if (addr === aqua) {
          const ev = decodeEventLog({ abi: aquaAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "Shipped") {
            const p = this.profile(ev.args.maker as Address);
            p.totalOffersShipped += 1;
            p.activeOffersCount += 1;
          }
        } else if (addr === router) {
          const ev = decodeEventLog({ abi: routerAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "OfferRepriced") {
            this.profile(ev.args.maker as Address).totalOffersRepriced += 1;
          } else if (ev.eventName === "OfferRevoked") {
            const p = this.profile(ev.args.maker as Address);
            p.totalOffersCancelled += 1;
            if (p.activeOffersCount > 0) p.activeOffersCount -= 1;
          }
        } else if (addr === registry) {
          const ev = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "CoverageSettled") {
            const p = this.profile(ev.args.underwriter as Address);
            p.totalCoverageSettled += 1;
            p.totalSettledVolume += ev.args.size as bigint;
            p.settledRateBpsSum += Number(((ev.args.rate as bigint) - 10n ** 18n) / 10n ** 14n); // (rate-1)*1e4
            p.lastSettlementTimestamp = Number(ev.args.timestamp as bigint);
            if (p.activeOffersCount > 0) p.activeOffersCount -= 1;
          }
        }
      } catch {
        /* not one of our decodable events */
      }
    }
  }

  /** Derived profile in the subgraph's `UnderwriterExecutionProfile` shape, or undefined. */
  getUnderwriterProfile(addr: Address): SubgraphUnderwriterProfile | undefined {
    const p = this.profiles.get(addr.toLowerCase());
    if (!p) return undefined;

    const resolved = p.totalCoverageSettled + p.totalOffersCancelled;
    const reliability = resolved > 0 ? p.totalCoverageSettled / resolved : 1;
    const avgSpreadBps = p.totalCoverageSettled > 0 ? Math.round(p.settledRateBpsSum / p.totalCoverageSettled) : 0;

    return {
      underwriter: p.underwriter,
      totalOffersShipped: String(p.totalOffersShipped),
      totalOffersRepriced: String(p.totalOffersRepriced),
      totalOffersCancelled: String(p.totalOffersCancelled),
      totalCoverageSettled: String(p.totalCoverageSettled),
      totalSettledVolume: p.totalSettledVolume.toString(),
      averageSpreadBps: String(avgSpreadBps),
      fillReliabilityScore: reliability.toFixed(4),
      reputationTier: reputationTier(reliability),
      activeOffersCount: String(p.activeOffersCount),
      lastSettlementTimestamp: String(p.lastSettlementTimestamp),
    };
  }

  /** All known underwriter addresses, lowercased. */
  knownUnderwriters(): string[] {
    return [...this.profiles.keys()];
  }
}
