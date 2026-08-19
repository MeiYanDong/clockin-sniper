# Production Readiness Receipt — 2026-08-18

## Decision

`NOT_HOT_ARMED`

This is a negative execution-readiness receipt, updated after deploying semantic website monitoring and priority public-RPC scheduling and then executing the owner's real-snipe arming audit. Control is `enabled/active` with only Robinhood's official public HTTP RPC; Executor, Reconciler and Exit remain `disabled/inactive`. Both paid-RPC and production-arm markers are absent because the final protocol/profile gates fail. This receipt does not authorize signing, broadcasting, or moving funds. The Observation Plane is public-only and the Execution Plane remains fail-closed.

## Current readback

| Gate | Current evidence | Result |
| --- | --- | --- |
| Network identity | Post-deploy public Control returned `chainId=4663`, head `39446492` and advancing at `2026-08-18T05:27:24Z`; the first scheduled identity refresh completed at `05:27:05Z` while foreground head polling continued | PASS CURRENT for public observation |
| Direct Sequencer write path | Root-only credential staged; an invalid-empty-transaction probe was deterministically rejected at `2026-08-18T05:09:09Z`; no signed or valid transaction was sent | PASS CURRENT write-method semantics / NOT ENABLED in Control |
| Production HTTP/WSS provider set | Public Control reports `robinhood-public-http`, `OFFICIAL_PUBLIC_HTTP_ONLY`, and `paidRpcCapability=false`; paid services and marker are absent | PASS CURRENT for public observation / deliberately NOT PAID-READY |
| Factory/Profile | Official mainnet Launcher Factory/final ABI not published; the scoped Launcher and `/docs` monitors both report `COMING_SOON`, zero mainnet candidates, and no current runtime/proxy hashes | BLOCKED |
| Exact/topic-wide channels | Generic channels tested; final address/topic/profile configuration unavailable | BLOCKED |
| Wallet identity | 10/10 external key/address correspondence verified locally and again against the root-only server key files without printing keys | PASS |
| Wallet funding/nonces | The post-deploy public readiness pass reported 10/10 funded wallets and 10/10 clean nonces without loading keys | PASS at `2026-08-18T05:22:04Z`; not a launch-time authorization |
| Principal/entry Gas/exit Gas | The same public snapshot reported `readyWallets=10` and `allInCapReady=true` under the frozen risk model | PASS at the latest hourly snapshot; must refresh in paid preparation |
| Price Snapshot | Control produced a fresh dual-source snapshot at startup, but the 30-second launch-time freshness gate intentionally expires between hourly cold wallet checks | BLOCKED for HOT_ARMED; refresh in explicit real-snipe preparation |
| Strategy authorization | Owner policy complete: `clockin-policy-v2`, revision `2`, config hash `sha256:a03505b3f0da3a92a5c45f70ff584ab26326ba9940996446325449392f7fb121`; 7-day TTL boundary tested; no current production AuthorizationRecord exists | PASS locally / BLOCKED for current launch |
| DB/leases/vault | SQLite WAL, atomic lease/nonce/reservation and encrypted vault recovery tested locally; a new vault key is backed up outside the repository and staged server-side `0400 root:root`; canonical SQLite is absent and no writer lease exists | PASS vault static / BLOCKED DB and lease for Execution Plane |
| Inner/outer exit | Generic contracts, route registry, net quote and policy tested; final sell/router/finalize profile unavailable | BLOCKED |
| UNKNOWN/open positions | The last Control readback reported zero unknown attempts and zero open positions; no Execution Plane database exists yet | PASS at the last readback / BLOCKED for current executor evidence |
| Artifact/systemd | Commit `de854f1d4c6e46b0bd6b872dec41889850b7dbcd`, package SHA-256 `409bff74c441e47806a976c7b76e95d50979fe8d7cb6ea7befe29bf238c59ba7`, capability revision `11`, runtime Node `v24.19.0`; Control is enabled/active with four scoped website signals, foreground/background public scheduling and no credential capability; three paid services are disabled/inactive and both markers are absent | PASS for public monitoring; BLOCKED for paid execution activation |
| Canonical effects | No v2 entry or exit receipt/token delta/quote delta | BLOCKED |

## Blocking owners and evidence needed

- `OFFICIAL_MAINNET_LAUNCHER_FACTORY_AND_FINAL_ABI_NOT_PUBLISHED` — owner: project/Launcher team; requires official addresses, final ABI and exact-block code identity.
- `OFFICIAL_FACTORY_LOG_FILTER_NOT_CONFIGURABLE_YET` — owner: project/Launcher team then engineering; public Control currently advances chain head and website fingerprints, but cannot invent a production exact/topic filter before the final Factory/event profile exists.
- `FINAL_MAINNET_POOL_BUY_SELL_FINALIZE_ADAPTERS_NOT_VERIFIED_CURRENT` — owner: engineering after protocol evidence; requires fork/replay and executable quotes.
- `BOUND_PRODUCTION_AUTHORIZATION_NOT_CREATED` — owner: launch operations; requires the final Factory/Profile plus an unexpired <=7-day AuthorizationRecord bound to the exact config/wallet/budget scope.
- `EXECUTION_SERVICES_DISABLED_INACTIVE_NO_PROFILE_AUTHORIZATION_OR_MARKERS` — owner: engineering/operations after protocol evidence; the artifacts, units, vault key and direct Sequencer credential are installed, but profile/authorization, signer readiness, SQLite WAL/lease, entry and exit services remain unavailable, and both paid-RPC and production-arm markers are absent.
- `ACTIVE_REGION_PERFORMANCE_NOT_BENCHMARKED` — owner: operations; the selected `us-west-1` host is healthy, but no reproducible multi-region WSS/RPC comparison has selected an optimal active-executor region.
- `NO_V2_CANONICAL_ENTRY_OR_EXIT_RECEIPT` — owner: event/runtime; can be resolved only by a real authorized event and canonical economic effects.

Until every pre-execution blocker is resolved, the default live entrypoint must remain fail-closed. Public Control currently returns `/health=200`, `/ready=503`, and `/dashboard=200`; the `503` truthfully represents `hotArmed=false`, Factory `UNKNOWN`, entry disabled and no verified mainnet exit route. The current deployment and arming boundary is recorded in [2026-08-18-control-hardening-and-arming-audit.md](./2026-08-18-control-hardening-and-arming-audit.md); the earlier paid-monitoring stop remains historical evidence in [2026-08-17-rpc-monitoring-pause.md](./2026-08-17-rpc-monitoring-pause.md).

## Source-only follow-up — 2026-08-20

Capability revision 12 introduces the [ADR 0010](../adr/0010-bounded-canary-and-staged-expansion.md) split between `CANARY_PREARMED` and full `HOT_ARMED`. Under that source design, missing sell/exit evidence no longer blocks the single maximum-5U canary after the exact Factory, launch/mechanism/native-buy ABI, non-empty launch code, fresh price, bound authorization, entry-01 readiness, Reconciler/WAL and zero-UNKNOWN gates pass. It still blocks every part of the remaining 45U.

This is not a new production receipt. The host readback above remains capability revision 11, all paid services remain disabled/inactive, both markers remain absent, and the final Factory/launch/buy profile and current authorization are still missing. Therefore even the narrower `CANARY_PREARMED` state is not currently achieved.
