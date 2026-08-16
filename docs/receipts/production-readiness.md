# Production Readiness Receipt — 2026-08-17

## Decision

`NOT_HOT_ARMED`

This is a negative readiness receipt. The keyless Control Sentinel is active, and the Executor, Reconciler and Exit artifacts/units are installed but deliberately `disabled` and `inactive`. This receipt does not authorize signing, broadcasting, or moving funds. The Execution Plane remains fail-closed.

## Current readback

| Gate | Current evidence | Result |
| --- | --- | --- |
| Network identity | Production Control readback returned `chainId=4663`, head `38143268`, lag `0` at `2026-08-16T17:08:31Z` | PASS for that observation |
| Direct Sequencer write path | Production Control's invalid-transaction probe passed; no valid or signed transaction was sent | PASS for write-probe semantics only |
| Production HTTP/WSS provider set | On `47.251.28.201` (`us-west-1`), authenticated HTTP and WSS plus the official Sequencer all reported ready; credentials were delivered through root-only files and were not logged | PASS for Control transport readiness |
| Factory/Profile | Official mainnet Launcher Factory/final ABI not published; no current runtime/proxy hashes | BLOCKED |
| Exact/topic-wide channels | Generic channels tested; final address/topic/profile configuration unavailable | BLOCKED |
| Wallet identity | 10/10 external key/address correspondence verified locally and again against the root-only server key files without printing keys | PASS |
| Wallet funding/nonces | 10/10 wallets each held `0.0032 ETH`; aggregate `0.032 ETH`; latest/pending nonce was `0/0` for every lane | PASS at the production readback |
| Principal/entry Gas/exit Gas | With one entry, one approval, three sells, 30% Gas margin and a 60U all-in cap, production Control reported `readyWallets=10`, `fundingReady=10`, `allInCapReady=true` | PASS for the current price/Gas snapshot |
| Price Snapshot | Production Control continuously froze a fresh dual-source snapshot under the 30s/2% policy | PASS for the current observation; not a launch authorization |
| Strategy authorization | Owner policy complete: `clockin-policy-v2`, revision `2`, config hash `sha256:a03505b3f0da3a92a5c45f70ff584ab26326ba9940996446325449392f7fb121`; 7-day TTL boundary tested; no current production AuthorizationRecord exists | PASS locally / BLOCKED for current launch |
| DB/leases/vault | SQLite WAL, atomic lease/nonce/reservation and encrypted vault recovery tested locally; the keyless Control intentionally reports signer/DB lease not ready | PASS locally / BLOCKED for Execution Plane |
| Inner/outer exit | Generic contracts, route registry, net quote and policy tested; final sell/router/finalize profile unavailable | BLOCKED |
| UNKNOWN/open positions | Control reported zero unknown attempts and zero open positions; no Execution Plane database exists yet | PASS for Control / BLOCKED for executor evidence |
| Artifact/systemd | Commit `16d02f05a54a33bfd0bb8bbce627b1aef892a689`, artifact SHA-256 `3152cd2a48ad4cd614fbd6d3ca5fd3e45d1cba1d978c75f3be15384de80844d7`, capability revision `5`, runtime Node `v24.19.0`; Control is enabled/active with `Type=notify`, a progressing 30s watchdog and `NRestarts=0`; Executor/Reconciler/Exit point to verified entrypoints but remain disabled/inactive | PASS for fail-closed runtime deployment; BLOCKED for execution activation |
| Canonical effects | No v2 entry or exit receipt/token delta/quote delta | BLOCKED |

## Blocking owners and evidence needed

- `OFFICIAL_MAINNET_LAUNCHER_FACTORY_AND_FINAL_ABI_NOT_PUBLISHED` — owner: project/Launcher team; requires official addresses, final ABI and exact-block code identity.
- `FINAL_MAINNET_POOL_BUY_SELL_FINALIZE_ADAPTERS_NOT_VERIFIED_CURRENT` — owner: engineering after protocol evidence; requires fork/replay and executable quotes.
- `BOUND_PRODUCTION_AUTHORIZATION_NOT_CREATED` — owner: launch operations; requires the final Factory/Profile plus an unexpired <=7-day AuthorizationRecord bound to the exact config/wallet/budget scope.
- `EXECUTION_SERVICES_DISABLED_INACTIVE_NO_PROFILE_AUTHORIZATION_OR_ARM_MARKER` — owner: engineering/operations after protocol evidence; the artifacts and units are installed, but signer readiness, SQLite WAL/lease, vault, entry and exit services remain deliberately disabled, and `PRODUCTION_ARM_APPROVED` is absent.
- `ACTIVE_REGION_PERFORMANCE_NOT_BENCHMARKED` — owner: operations; the selected `us-west-1` host is healthy, but no reproducible multi-region WSS/RPC comparison has selected an optimal active-executor region.
- `NO_V2_CANONICAL_ENTRY_OR_EXIT_RECEIPT` — owner: event/runtime; can be resolved only by a real authorized event and canonical economic effects.

Until every pre-execution blocker is resolved, `/ready` must report false and the default live entrypoint must remain fail-closed. The production readback correctly returned HTTP `503`, `hotArmed=false`, `signerReady=0`, Factory `UNKNOWN`, entry disabled and no verified mainnet exit route. The exact deployment and rollback evidence is recorded in [2026-08-17-production-runtime-deployment.md](./2026-08-17-production-runtime-deployment.md).
