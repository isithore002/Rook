/** Spawn / wait-for / stop a local Anvil node for the e2e and demo runners. */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createPublicClient, http } from "viem";

/** Fixed genesis timestamp so back-to-back runs are byte-reproducible. */
export const FIXED_GENESIS = 1_780_000_000;

export async function startAnvil(port: number): Promise<ChildProcess> {
  // Rook contracts build with the Yul optimizer off (foundry.toml `lowmem`), so
  // bytecode runs large — lift Anvil's EIP-170/3860 limits. Fixed --timestamp
  // makes the whole run deterministic.
  const proc = spawn(
    "anvil",
    [
      "--port", String(port),
      "--silent",
      "--disable-code-size-limit",
      "--gas-limit", "18000000000",
      "--timestamp", String(FIXED_GENESIS),
    ],
    { stdio: "ignore" },
  );
  const rpc = `http://127.0.0.1:${port}`;
  const client = createPublicClient({ transport: http(rpc) });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await client.getBlockNumber();
      return proc;
    } catch {
      await sleep(300);
    }
  }
  proc.kill("SIGTERM");
  throw new Error(`Anvil did not come up on ${rpc}`);
}

export async function stopAnvil(proc: ChildProcess | undefined, port?: number): Promise<void> {
  proc?.kill("SIGTERM");
  if (port === undefined) return;
  const client = createPublicClient({ transport: http(`http://127.0.0.1:${port}`) });
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      await client.getBlockNumber();
      await sleep(200);
    } catch {
      return; // port no longer answering — safe to reuse
    }
  }
}
