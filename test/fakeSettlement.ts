import type { SettlementLookup } from "../services/BazanticGatewayServer.ts";

/**
 * Test-only settlement lookup: reports `isSettled: true` for the given txRefs,
 * `false` for anything else. Lets the off-chain suites exercise the gateway's
 * request -> lookup -> response plumbing without a chain. The real
 * RookRegistry-backed lookup is exercised by `npm run demo`.
 */
export function fakeSettlement(settledTxRefs: string[]): SettlementLookup {
  const set = new Set(settledTxRefs.map((r) => r.toLowerCase()));
  return async (txRef: string) =>
    set.has(txRef.toLowerCase())
      ? { isSettled: true, underwriter: "0x00000000000000000000000000000000000000a1", size: "1", timestamp: 1_700_000_000 }
      : { isSettled: false };
}
