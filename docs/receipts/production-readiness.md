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
| Principal/entry Gas/exit Gas | Readiness calculator tested; no funded reserves | BLOCKED |
| Price Snapshot | Adapters tested; owner freshness/deviation policy unresolved | BLOCKED |
| Strategy authorization | `clockin-policy-v1`, revision `1`, config hash `sha256:aa6aba0b39ea67776ec1f3c47475f2bc3ffd16c90e0a5ba3198d5f165181b012`; six owner-controlled bounds unresolved | BLOCKED |
| DB/leases/vault | SQLite WAL, atomic lease/nonce/reservation and encrypted vault recovery tested locally | PASS locally, not deployed |
| Inner/outer exit | Generic contracts, route registry, net quote and policy tested; final sell/router/finalize profile unavailable | BLOCKED |
| UNKNOWN/open positions | No v2 live execution occurred; no production database readback exists | BLOCKED for deployment evidence |
| Artifact/systemd | v2 archive and templates tested locally; no approved cloud host or `systemctl show` readback | BLOCKED |
| Canonical effects | No v2 entry or exit receipt/token delta/quote delta | BLOCKED |

## Blocking owners and evidence needed

- `OFFICIAL_MAINNET_LAUNCHER_FACTORY_AND_FINAL_ABI_NOT_PUBLISHED` — owner: project/Launcher team; requires official addresses, final ABI and exact-block code identity.
- `FINAL_MAINNET_POOL_BUY_SELL_FINALIZE_ADAPTERS_NOT_VERIFIED_CURRENT` — owner: engineering after protocol evidence; requires fork/replay and executable quotes.
- `ENTRY_WALLETS_NOT_FUNDED` — owner: project owner; requires per-wallet principal plus independent entry/exit Gas reserves and clean nonces.
- `PRICE_AND_EXIT_RISK_BOUNDS_NOT_FULLY_DECIDED` — owner: project owner; requires price age/deviation, maximum holding/momentum, stop-loss and `EXIT_NOW` slippage choices.
- `CLOUD_REGION_AND_HOST_NOT_SELECTED_OR_DEPLOYED` — owner: project owner/operations; requires candidate regions, provider benchmark, approved host and protected deployment receipt.
- `NO_V2_CANONICAL_ENTRY_OR_EXIT_RECEIPT` — owner: event/runtime; can be resolved only by a real authorized event and canonical economic effects.

Until every blocker is resolved, `/ready` must report false and the default live entrypoint must remain fail-closed.
