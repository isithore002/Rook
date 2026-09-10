/**
 * Deploy the full local Rook stack to a running node using the Foundry build
 * artifacts in `swap-vm/out/` (no `forge script` — that unit OOMs solc here).
 * Writes `swap-vm/deployments/local.json` and returns the address book.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Abi, Address, Hex } from "viem";
import { walletFor, publicClient, type Deployment } from "../chain/config.ts";

const OUT = resolve(import.meta.dirname, "../swap-vm/out");
const DEPLOY_DIR = resolve(import.meta.dirname, "../swap-vm/deployments");
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const EXPLOIT_TARGET = "0x000000000000000000000000000000000000dEaD" as Address;
const FUND = 1_000_000n * 10n ** 18n;

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(resolve(OUT, file, `${name}.json`), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
}

const mintAbi = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
] as const;
const setBlockedAbi = [
  { type: "function", name: "setBlockedTarget", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "bool" }], outputs: [] },
] as const;

export async function deploy(): Promise<Deployment> {
  const pub = publicClient();
  const { client, address: deployer } = walletFor(0);
  const acct = client.account!;

  async function dep(file: string, name: string, args: unknown[] = []): Promise<Address> {
    const { abi, bytecode } = artifact(file, name);
    const hash = await client.deployContract({ abi, bytecode, args, account: acct, chain: client.chain });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (!rc.contractAddress) throw new Error(`deploy ${name}: no contractAddress`);
    return rc.contractAddress;
  }
  async function send(address: Address, abi: Abi, functionName: string, args: unknown[]): Promise<void> {
    const hash = await client.writeContract({ address, abi, functionName, args, account: acct, chain: client.chain });
    await pub.waitForTransactionReceipt({ hash });
  }

  const aqua = await dep("Aqua.sol", "Aqua");
  const router = await dep("AquaSwapVMRouter.sol", "AquaSwapVMRouter", [aqua, ZERO, deployer, "SwapVM", "1.0.0"]);
  const registry = await dep("RookRegistry.sol", "RookRegistry");
  const executor = await dep("AgentHedgeExecutor.sol", "AgentHedgeExecutor", [router, registry]);
  const periphery = await dep("RookPeriphery.sol", "RookPeriphery");
  const demoTarget = await dep("RookPeriphery.sol", "RookDemoTarget");
  const tokenA = await dep("RookPeriphery.sol", "RookMintableToken", ["Rook Risk Token", "RISK"]);
  const tokenB = await dep("RookPeriphery.sol", "RookMintableToken", ["Rook Safe Token", "SAFE"]);
  const [riskToken, safeToken] = BigInt(tokenA) < BigInt(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA];

  const underwriters = [walletFor(1).address, walletFor(2).address, walletFor(3).address];
  const actingAgent = walletFor(4).address;

  for (const uw of underwriters) await send(safeToken, mintAbi as unknown as Abi, "mint", [uw, FUND]);
  await send(riskToken, mintAbi as unknown as Abi, "mint", [actingAgent, FUND]);

  // tx-risky-02 (MOCKS.md §3): the flagged exploit address is hard-blocked up front.
  await send(executor, setBlockedAbi as unknown as Abi, "setBlockedTarget", [EXPLOIT_TARGET, true]);

  const deployment: Deployment = {
    aqua, router, registry, executor, periphery, demoTarget,
    exploitTarget: EXPLOIT_TARGET, riskToken, safeToken, deployer, actingAgent, underwriters,
  };
  mkdirSync(DEPLOY_DIR, { recursive: true });
  writeFileSync(resolve(DEPLOY_DIR, "local.json"), `${JSON.stringify(deployment, null, 2)}\n`);
  return deployment;
}
