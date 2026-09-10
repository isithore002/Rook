/**
 * RookChain — thin viem wrapper around the deployed Rook stack. One instance is
 * shared by the off-chain agents so they issue *real* transactions against a
 * running Anvil node (ship / reprice / cancel offers, protected fills) and read
 * settlement state back from `RookRegistry`.
 */
import {
  decodeEventLog,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  loadDeployment,
  publicClient,
  walletFor,
  keyIndexForAddress,
  type Deployment,
} from "./config.ts";
import { aquaAbi, erc20Abi, executorAbi, peripheryAbi, registryAbi, routerAbi } from "./abis.ts";

export interface BuiltOrder {
  order: { maker: Address; traits: bigint; data: Hex };
  strategyBytes: Hex;
}

export interface ShipResult {
  txHash: Hex;
  strategyHash: Hex;
  offerId: Hex;
  order: BuiltOrder["order"];
}

export interface ProtectedFillResult {
  txHash: Hex;
  blockNumber: bigint;
  underwriter: Address;
  safeAmountOut: bigint;
  coverageRecorded: boolean;
}

export class RookChain {
  readonly d: Deployment;
  readonly pub: PublicClient;

  constructor(d?: Deployment, pub?: PublicClient) {
    this.d = d ?? loadDeployment();
    this.pub = pub ?? publicClient();
  }

  keyIndexFor(addr: Address): number {
    return keyIndexForAddress(this.d, addr);
  }

  /** Latest block timestamp. */
  async chainNow(): Promise<number> {
    const block = await this.pub.getBlock({ blockTag: "latest" });
    return Number(block.timestamp);
  }

  /**
   * An offer expiry `hoursAhead` from now, snapped up to the next hour boundary.
   * Anvil tracks `block.timestamp` to wall clock, so snapping keeps the encoded
   * order bytes (and therefore every downstream tx hash) identical across two
   * back-to-back demo runs.
   */
  async validWhile(hoursAhead = 1): Promise<number> {
    const target = (await this.chainNow()) + hoursAhead * 3600;
    return Math.ceil(target / 3600) * 3600;
  }

  // --- builders (pure, via the periphery contract) ---

  async buildOrder(
    maker: Address,
    offerId: Hex,
    rateIn: bigint,
    rateOut: bigint,
    maxSize: bigint,
    validWhile: number,
  ): Promise<BuiltOrder> {
    const [order, strategyBytes] = (await this.pub.readContract({
      address: this.d.periphery,
      abi: peripheryAbi,
      functionName: "buildRevocableRateOfferOrder",
      args: [maker, this.d.riskToken, this.d.safeToken, offerId, rateIn, rateOut, maxSize, validWhile],
    })) as unknown as [BuiltOrder["order"], Hex];
    return { order, strategyBytes };
  }

  buildTakerTraits(taker: Address, to: Address): Promise<Hex> {
    return this.pub.readContract({
      address: this.d.periphery,
      abi: peripheryAbi,
      functionName: "buildTakerTraits",
      args: [taker, to],
    }) as Promise<Hex>;
  }

  // --- writes ---

  private async approveMax(keyIdx: number, token: Address, spender: Address): Promise<void> {
    const { client, address } = walletFor(keyIdx);
    const current = (await this.pub.readContract({
      address: token, abi: erc20Abi, functionName: "allowance", args: [address, spender],
    })) as bigint;
    if (current >= 2n ** 200n) return;
    const hash = await client.writeContract({
      address: token, abi: erc20Abi, functionName: "approve",
      args: [spender, 2n ** 256n - 1n], account: client.account!, chain: client.chain,
    });
    await this.pub.waitForTransactionReceipt({ hash });
  }

  /** Underwriter ships a RevocableRateOffer position, backing it with `capacity` SAFE in Aqua. */
  async shipOffer(
    maker: Address,
    offerId: Hex,
    rateIn: bigint,
    rateOut: bigint,
    capacity: bigint,
    validWhile: number,
  ): Promise<ShipResult> {
    const keyIdx = this.keyIndexFor(maker);
    const built = await this.buildOrder(maker, offerId, rateIn, rateOut, capacity, validWhile);
    await this.approveMax(keyIdx, this.d.safeToken, this.d.aqua);
    await this.approveMax(keyIdx, this.d.riskToken, this.d.aqua);

    const { client } = walletFor(keyIdx);
    const tokens = [this.d.riskToken, this.d.safeToken] as const;
    const amounts = [0n, capacity] as const;
    const { result: strategyHash, request } = await this.pub.simulateContract({
      address: this.d.aqua, abi: aquaAbi, functionName: "ship",
      args: [this.d.router, built.strategyBytes, tokens as unknown as Address[], amounts as unknown as bigint[]],
      account: client.account!,
    });
    const txHash = await client.writeContract(request);
    await this.pub.waitForTransactionReceipt({ hash: txHash });
    return { txHash, strategyHash: strategyHash as Hex, offerId, order: built.order };
  }

  async repriceOffer(maker: Address, offerId: Hex, newRateIn: bigint, newRateOut: bigint): Promise<Hex> {
    const { client } = walletFor(this.keyIndexFor(maker));
    const hash = await client.writeContract({
      address: this.d.router, abi: routerAbi, functionName: "repriceOffer",
      args: [offerId, newRateIn, newRateOut], account: client.account!, chain: client.chain,
    });
    await this.pub.waitForTransactionReceipt({ hash });
    return hash;
  }

  async cancelOffer(maker: Address, offerId: Hex): Promise<Hex> {
    const { client } = walletFor(this.keyIndexFor(maker));
    const hash = await client.writeContract({
      address: this.d.router, abi: routerAbi, functionName: "cancelOffer",
      args: [offerId], account: client.account!, chain: client.chain,
    });
    await this.pub.waitForTransactionReceipt({ hash });
    return hash;
  }

  getOfferState(maker: Address, offerId: Hex) {
    return this.pub.readContract({
      address: this.d.router, abi: routerAbi, functionName: "getOfferState", args: [maker, offerId],
    }) as Promise<readonly [boolean, bigint, bigint, bigint]>;
  }

  /** Acting agent runs a protected fill: hedge swap -> registry record -> (optional) target call, atomic. */
  async executeProtected(params: {
    caller: Address;
    txRef: Hex;
    order: BuiltOrder["order"];
    swapAmountIn: bigint;
    expectedHedgeRate: bigint;
    target: Address;
    targetCalldata: Hex;
  }): Promise<ProtectedFillResult> {
    const keyIdx = this.keyIndexFor(params.caller);
    await this.approveMax(keyIdx, this.d.riskToken, this.d.executor);
    // Recipient = executor: the router hands it the SAFE output, which
    // AgentHedgeExecutor.executeProtected then forwards to the caller (step 4).
    const takerTraits = await this.buildTakerTraits(this.d.executor, this.d.executor);
    const { client } = walletFor(keyIdx);

    const { request } = await this.pub.simulateContract({
      address: this.d.executor, abi: executorAbi, functionName: "executeProtected",
      args: [
        params.txRef, this.d.riskToken, this.d.safeToken, params.order,
        params.swapAmountIn, takerTraits, params.expectedHedgeRate,
        params.target, params.targetCalldata,
      ],
      account: client.account!,
    });
    const txHash = await client.writeContract(request);
    const receipt = await this.pub.waitForTransactionReceipt({ hash: txHash });

    let underwriter = "0x0000000000000000000000000000000000000000" as Address;
    let safeAmountOut = 0n;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.d.executor.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: executorAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "ProtectedExecutionCompleted") {
          underwriter = ev.args.underwriter as Address;
          safeAmountOut = ev.args.safeAmountOut as bigint;
        }
      } catch { /* not our event */ }
    }
    const coverageRecorded = await this.hasCoverage(params.txRef);
    return { txHash, blockNumber: receipt.blockNumber, underwriter, safeAmountOut, coverageRecorded };
  }

  async setBlockedTarget(caller: Address, target: Address, blocked: boolean): Promise<Hex> {
    const { client } = walletFor(this.keyIndexFor(caller));
    const hash = await client.writeContract({
      address: this.d.executor, abi: executorAbi, functionName: "setBlockedTarget",
      args: [target, blocked], account: client.account!, chain: client.chain,
    });
    await this.pub.waitForTransactionReceipt({ hash });
    return hash;
  }

  hasCoverage(txRef: Hex): Promise<boolean> {
    return this.pub.readContract({
      address: this.d.registry, abi: registryAbi, functionName: "hasCoverage", args: [txRef],
    }) as Promise<boolean>;
  }

  getCoverage(txRef: Hex) {
    return this.pub.readContract({
      address: this.d.registry, abi: registryAbi, functionName: "getCoverage", args: [txRef],
    });
  }

  /** Encode a call to the demo MockRiskyTarget.executeArbitrage(units). */
  static encodeArbitrageCall(units: bigint): Hex {
    return encodeFunctionData({
      abi: [{ type: "function", name: "executeArbitrage", stateMutability: "nonpayable", inputs: [{ name: "units", type: "uint256" }], outputs: [{ type: "bool" }] }],
      functionName: "executeArbitrage",
      args: [units],
    });
  }
}
