/**
 * Chain wiring for the off-chain Rook agents: a viem public client, per-role
 * wallet clients, and the deployed-address book written by
 * `swap-vm/script/DeployRook.s.sol` -> `swap-vm/deployments/local.json`.
 *
 * All keys here are the standard, publicly documented Anvil dev keys
 * ("test test test ... junk" mnemonic). Fork/test funds only — real key
 * management is out of scope (ARCHITECTURE.md §7).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));

export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);

/** Anvil dev keys, index 0..4 (deployer, underwriter 1-3, acting agent). */
export const ANVIL_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
];

export interface Deployment {
  aqua: Address;
  router: Address;
  registry: Address;
  executor: Address;
  periphery: Address;
  demoTarget: Address;
  exploitTarget: Address;
  riskToken: Address;
  safeToken: Address;
  deployer: Address;
  actingAgent: Address;
  underwriters: Address[];
}

export function loadDeployment(path?: string): Deployment {
  const p = path ?? resolve(HERE, "../swap-vm/deployments/local.json");
  return JSON.parse(readFileSync(p, "utf8")) as Deployment;
}

const localChain = {
  id: CHAIN_ID,
  name: "anvil-local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;

export function publicClient(): PublicClient {
  return createPublicClient({ chain: localChain, transport: http(RPC_URL) });
}

/** Wallet client for Anvil account `index` (0..4). */
export function walletFor(index: number): { client: WalletClient; address: Address } {
  const account = privateKeyToAccount(ANVIL_KEYS[index]);
  const client = createWalletClient({ account, chain: localChain, transport: http(RPC_URL) });
  return { client, address: account.address };
}

/** Map a role address from the deployment back to its Anvil key index. */
export function keyIndexForAddress(d: Deployment, addr: Address): number {
  const all = [d.deployer, ...d.underwriters, d.actingAgent];
  const anvil = ANVIL_KEYS.map((k) => privateKeyToAccount(k).address.toLowerCase());
  const i = anvil.indexOf(addr.toLowerCase());
  if (i < 0) throw new Error(`no Anvil key for ${addr} (roles: ${all.join(", ")})`);
  return i;
}
