# Production Readiness Receipt — 2026-08-17

## Decision

`NOT_HOT_ARMED`

This is a negative readiness receipt, updated after the owner paused paid Chainstack RPC usage at `2026-08-17T06:20:59Z`. Control, Executor, Reconciler and Exit are all `disabled` and `inactive`. This receipt does not authorize signing, broadcasting, or moving funds. The Observation Plane is paused and the Execution Plane remains fail-closed.

## Current readback

| Gate | Current evidence | Result |
| --- | --- | --- |
| Network identity | Production Control previously returned `chainId=4663`, head `38143268`, lag `0` at `2026-08-16T17:08:31Z`; Control is now stopped | PASS for the historical observation / NOT CURRENT |
| Direct Sequencer write path | Production Control's invalid-transaction probe previously passed; no valid or signed transaction was sent; Control is now stopped | PASS for historical probe semantics / NOT CURRENT |
| Production HTTP/WSS provider set | Authenticated HTTP/WSS and the official Sequencer previously reported ready; Control was then disabled to stop paid RPC traffic | PAUSED / no current transport readiness |
| Factory/Profile | Official mainnet Launcher Factory/final ABI not published; no current runtime/proxy hashes | BLOCKED |
| Exact/topic-wide channels | Generic channels tested; final address/topic/profile configuration unavailable | BLOCKED |
| Wallet identity | 10/10 external key/address correspondence verified locally and again against the root-only server key files without printing keys | PASS |
| Wallet funding/nonces | 10/10 wallets previously held `0.0032 ETH`; aggregate `0.032 ETH`; latest/pending nonce was `0/0` for every lane | PASS at the last readback / NOT CURRENT |
| Principal/entry Gas/exit Gas | With one entry, one approval, three sells, 30% Gas margin and a 60U all-in cap, production Control previously reported `readyWallets=10`, `fundingReady=10`, `allInCapReady=true` | PASS at the last snapshot / NOT CURRENT |
| Price Snapshot | Production Control previously froze fresh dual-source snapshots under the 30s/2% policy; it is now stopped | BLOCKED: no live price snapshot |
| Strategy authorization | Owner policy complete: `clockin-policy-v2`, revision `2`, config hash `sha256:a03505b3f0da3a92a5c45f70ff584ab26326ba9940996446325449392f7fb121`; 7-day TTL boundary tested; no current production AuthorizationRecord exists | PASS locally / BLOCKED for current launch |
| DB/leases/vault | SQLite WAL, atomic lease/nonce/reservation and encrypted vault recovery tested locally; the keyless Control intentionally reports signer/DB lease not ready | PASS locally / BLOCKED for Execution Plane |
| Inner/outer exit | Generic contracts, route registry, net quote and policy tested; final sell/router/finalize profile unavailable | BLOCKED |
| UNKNOWN/open positions | The last Control readback reported zero unknown attempts and zero open positions; no Execution Plane database exists yet | PASS at the last readback / BLOCKED for current executor evidence |
| Artifact/systemd | Commit `16d02f05a54a33bfd0bb8bbce627b1aef892a689`, artifact SHA-256 `3152cd2a48ad4cd614fbd6d3ca5fd3e45d1cba1d978c75f3be15384de80844d7`, capability revision `5`, runtime Node `v24.19.0`; all four units are now disabled/inactive, PID counts are zero and the arm marker is absent | PASS for deliberate fail-closed pause; BLOCKED for monitoring and execution activation |
| Canonical effects | No v2 entry or exit receipt/token delta/quote delta | BLOCKED |

## Blocking owners and evidence needed

- `OFFICIAL_MAINNET_LAUNCHER_FACTORY_AND_FINAL_ABI_NOT_PUBLISHED` — owner: project/Launcher team; requires official addresses, final ABI and exact-block code identity.
- `CONTROL_SENTINEL_PAUSED_FOR_CHAINSTACK_USAGE` — owner: operations; owner-directed cost stop. There is no live chain head, Factory/CA, website correlation, price, readiness or Dashboard update until a deliberate resume and fresh readback.
- `FINAL_MAINNET_POOL_BUY_SELL_FINALIZE_ADAPTERS_NOT_VERIFIED_CURRENT` — owner: engineering after protocol evidence; requires fork/replay and executable quotes.
- `BOUND_PRODUCTION_AUTHORIZATION_NOT_CREATED` — owner: launch operations; requires the final Factory/Profile plus an unexpired <=7-day AuthorizationRecord bound to the exact config/wallet/budget scope.
- `EXECUTION_SERVICES_DISABLED_INACTIVE_NO_PROFILE_AUTHORIZATION_OR_ARM_MARKER` — owner: engineering/operations after protocol evidence; the artifacts and units are installed, but signer readiness, SQLite WAL/lease, vault, entry and exit services remain deliberately disabled, and `PRODUCTION_ARM_APPROVED` is absent.
- `ACTIVE_REGION_PERFORMANCE_NOT_BENCHMARKED` — owner: operations; the selected `us-west-1` host is healthy, but no reproducible multi-region WSS/RPC comparison has selected an optimal active-executor region.
- `NO_V2_CANONICAL_ENTRY_OR_EXIT_RECEIPT` — owner: event/runtime; can be resolved only by a real authorized event and canonical economic effects.

Until every pre-execution blocker is resolved, the default live entrypoint must remain fail-closed. Because Control is stopped, `/health`, `/ready` and `/dashboard` are intentionally offline rather than current readiness signals. The last production readback returned HTTP `503`, `hotArmed=false`, `signerReady=0`, Factory `UNKNOWN`, entry disabled and no verified mainnet exit route. Historical deployment evidence is recorded in [2026-08-17-production-runtime-deployment.md](./2026-08-17-production-runtime-deployment.md); current stop evidence is recorded in [2026-08-17-rpc-monitoring-pause.md](./2026-08-17-rpc-monitoring-pause.md).
