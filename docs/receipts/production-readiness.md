# Production Readiness Receipt — 2026-08-16

## Decision

`NOT_HOT_ARMED`

This is a negative readiness receipt. It records current evidence and blockers; it does not authorize signing, broadcasting, funding movement, or deployment.

## Current readback

| Gate | Current evidence | Result |
| --- | --- | --- |
| Network identity | Official public RPC returned `chainId=4663`, head `37876622`, EIP-1559 base fee `22644000 wei` at `2026-08-16T09:42:34.910Z` | PASS for that observation only |
| Direct Sequencer write path | Official endpoint deterministically rejected an invalid empty transaction at `2026-08-16T09:42:37.002Z`; no signed transaction was sent | PASS for write-probe semantics only |
| Production HTTP/WSS provider set | User credential was deliberately not copied to commands, logs, or repository; no cloud-region readback | BLOCKED |
| Factory/Profile | Official mainnet Launcher Factory/final ABI not published; no current runtime/proxy hashes | BLOCKED |
| Exact/topic-wide channels | Generic channels tested; final address/topic/profile configuration unavailable | BLOCKED |
| Wallet identity | 10/10 external key/address correspondence verified without exposing keys | PASS locally |
| Wallet funding/nonces | Wallets unfunded; no current 10/10 chain balance/nonce matrix | BLOCKED |
| Principal/entry Gas/exit Gas | Readiness calculator reserves one entry, one approval, three sells and 30% Gas margin under a 60U all-in cap; wallets remain unfunded | BLOCKED |
| Price Snapshot | Dual-source/manual-fallback adapters tested; policy frozen at 30s age and 2% deviation; no fresh launch-bound snapshot exists | BLOCKED |
| Strategy authorization | Owner policy complete: `clockin-policy-v2`, revision `2`, config hash `sha256:a03505b3f0da3a92a5c45f70ff584ab26326ba9940996446325449392f7fb121`; 7-day TTL boundary tested; no current production AuthorizationRecord exists | PASS locally / BLOCKED for current launch |
| DB/leases/vault | SQLite WAL, atomic lease/nonce/reservation and encrypted vault recovery tested locally | PASS locally, not deployed |
| Inner/outer exit | Generic contracts, route registry, net quote and policy tested; final sell/router/finalize profile unavailable | BLOCKED |
| UNKNOWN/open positions | No v2 live execution occurred; no production database readback exists | BLOCKED for deployment evidence |
| Artifact/systemd | v2 archive and templates tested locally; no approved cloud host or `systemctl show` readback | BLOCKED |
| Canonical effects | No v2 entry or exit receipt/token delta/quote delta | BLOCKED |

## Blocking owners and evidence needed

- `OFFICIAL_MAINNET_LAUNCHER_FACTORY_AND_FINAL_ABI_NOT_PUBLISHED` — owner: project/Launcher team; requires official addresses, final ABI and exact-block code identity.
- `FINAL_MAINNET_POOL_BUY_SELL_FINALIZE_ADAPTERS_NOT_VERIFIED_CURRENT` — owner: engineering after protocol evidence; requires fork/replay and executable quotes.
- `ENTRY_WALLETS_NOT_FUNDED` — owner: project owner; requires per-wallet principal plus one entry, one approval, three sells, 30% Gas margin and clean nonces, all inside the frozen 60U all-in cap.
- `FRESH_PRICE_SNAPSHOT_AND_BOUND_AUTHORIZATION_NOT_CREATED` — owner: launch operations; requires a <=30s dual-source snapshot (<=2% deviation) and an unexpired <=7-day AuthorizationRecord bound to the final profile/config/wallet/budget scope.
- `CLOUD_REGION_AND_HOST_NOT_SELECTED_OR_DEPLOYED` — owner: project owner/operations; requires candidate regions, provider benchmark, approved host and protected deployment receipt.
- `NO_V2_CANONICAL_ENTRY_OR_EXIT_RECEIPT` — owner: event/runtime; can be resolved only by a real authorized event and canonical economic effects.

Until every blocker is resolved, `/ready` must report false and the default live entrypoint must remain fail-closed.
