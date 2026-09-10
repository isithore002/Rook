# Rook Subgraph

Indexes the Rook protocol's on-chain events and derives underwriter
intelligence the Acting Agent uses to vet quotes:

| Source | Events | Derives |
|---|---|---|
| `RookRegistry` | `CoverageSettled` | settlement history, realized spread, `totalSettledVolume` |
| `Aqua` | `Shipped`, `Docked` | `HedgeOffer` lifecycle, `totalOffersShipped` |
| `SwapVMRouter` | `OfferRepriced`, `OfferRevoked` | `totalOffersRepriced`, `totalOffersCancelled` — the **authoritative cancellation signal** |

`UnderwriterExecutionProfile.fillReliabilityScore = settled / (settled + cancelled)`
(0..1, default 1.0), bucketed into `TIER_1_PRIME` (≥0.75) / `TIER_2_STANDARD`
(≥0.40) / `TIER_3_VOLATILE`.

## Two implementations, one derivation

- **`src/mapping.ts` (this directory)** — the AssemblyScript mapping for a real
  `graph-node` deployment. Build it where Docker or a hosted indexer is
  available:

  ```bash
  npm i -g @graphprotocol/graph-cli
  graph codegen && graph build
  # local graph-node (docker compose up in a graph-node checkout), then:
  graph create --node http://localhost:8020/ rook/rook-protocol
  graph deploy --node http://localhost:8020/ --ipfs http://localhost:5001 rook/rook-protocol
  ```

  Set the three `source.address` fields in `subgraph.yaml` to the deployed
  addresses first (see `swap-vm/deployments/local.json`).

- **`services/RookIndexer.ts` (repo root)** — a Docker-free TypeScript
  reimplementation of the *same* derivation, driven by `viem` `getLogs`. This is
  what `npm run e2e` exercises: it replays the real logs and derives the
  profiles the Acting Agent vets against, so the demo's underwriter
  disqualification runs on real indexed history, not a hand-written literal.

Keep the two in sync — `RookIndexer` is the reference for the reliability
formula and tier thresholds.

## Note on offer economics

Aqua's `Shipped` event carries only the abi-encoded strategy blob; the
RevocableRateOffer rate/size sit inside `strategy.data` behind the SwapVM
instruction encoding. Both implementations therefore track offer economics from
`OfferRepriced` and `CoverageSettled.rate` rather than decoding the program.
