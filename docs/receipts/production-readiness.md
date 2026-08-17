# Production Readiness Receipt — 2026-08-17

## Decision

`NOT_HOT_ARMED`

This is a negative execution-readiness receipt, updated after deploying the owner's public/paid RPC boundary. Control is `enabled/active` with only Robinhood's official public HTTP RPC; Executor, Reconciler and Exit remain `disabled/inactive`. Both paid-RPC and production-arm markers are absent. This receipt does not authorize signing, broadcasting, or moving funds. The Observation Plane is public-only and the Execution Plane remains fail-closed.

## Current readback

| Gate | Current evidence | Result |
| --- | --- | --- |
| Network identity | Public Control returned `chainId=4663`; head advanced from `38667399` to `38673034`, and two scheduled five-minute identity rechecks advanced their timestamps and `eth_chainId` counter | PASS CURRENT for public observation |
| Direct Sequencer write path | Historical invalid-transaction probe passed; public Control deliberately has no Sequencer capability | PASS historical semantics / NOT ENABLED outside paid execution window |
| Production HTTP/WSS provider set | Public Control reports `robinhood-public-http`, `OFFICIAL_PUBLIC_HTTP_ONLY`, and `paidRpcCapability=false`; paid services and marker are absent | PASS CURRENT for public observation / deliberately NOT PAID-READY |
| Factory/Profile | Official mainnet Launcher Factory/final ABI not published; no current runtime/proxy hashes | BLOCKED |
| Exact/topic-wide channels | Generic channels tested; final address/topic/profile configuration unavailable | BLOCKED |
| Wallet identity | 10/10 external key/address correspondence verified locally and again against the root-only server key files without printing keys | PASS |
| Wallet funding/nonces | The public hourly readiness pass reported 10/10 funded wallets and 10/10 clean nonces without loading keys | PASS at `2026-08-17T07:44:00Z`; not a launch-time authorization |
| Principal/entry Gas/exit Gas | The same public snapshot reported `readyWallets=10` and `allInCapReady=true` under the frozen risk model | PASS at the latest hourly snapshot; must refresh in paid preparation |
| Price Snapshot | Control produced a fresh dual-source snapshot at startup, but the 30-second launch-time freshness gate intentionally expires between hourly cold wallet checks | BLOCKED for HOT_ARMED; refresh in explicit real-snipe preparation |
| Strategy authorization | Owner policy complete: `clockin-policy-v2`, revision `2`, config hash `sha256:a03505b3f0da3a92a5c45f70ff584ab26326ba9940996446325449392f7fb121`; 7-day TTL boundary tested; no current production AuthorizationRecord exists | PASS locally / BLOCKED for current launch |
| DB/leases/vault | SQLite WAL, atomic lease/nonce/reservation and encrypted vault recovery tested locally; the keyless Control intentionally reports signer/DB lease not ready | PASS locally / BLOCKED for Execution Plane |
| Inner/outer exit | Generic contracts, route registry, net quote and policy tested; final sell/router/finalize profile unavailable | BLOCKED |
| UNKNOWN/open positions | The last Control readback reported zero unknown attempts and zero open positions; no Execution Plane database exists yet | PASS at the last readback / BLOCKED for current executor evidence |
| Artifact/systemd | Commit `2a5e9e3586a395b62731b961bb97087ab96786a5`, artifact SHA-256 `0d4ad1f039e74e34bc21255c492d79a1154da8b778df38281c3327857ad634b2`, capability revision `9`, runtime Node `v24.19.0`; Control is enabled/active with paced public RPC, independent periodic identity rechecks and no credential capability, three paid services are disabled/inactive and both markers are absent | PASS for public monitoring; BLOCKED for paid execution activation |
| Canonical effects | No v2 entry or exit receipt/token delta/quote delta | BLOCKED |

## Blocking owners and evidence needed

- `OFFICIAL_MAINNET_LAUNCHER_FACTORY_AND_FINAL_ABI_NOT_PUBLISHED` — owner: project/Launcher team; requires official addresses, final ABI and exact-block code identity.
- `OFFICIAL_FACTORY_LOG_FILTER_NOT_CONFIGURABLE_YET` — owner: project/Launcher team then engineering; public Control currently advances chain head and website fingerprints, but cannot invent a production exact/topic filter before the final Factory/event profile exists.
- `FINAL_MAINNET_POOL_BUY_SELL_FINALIZE_ADAPTERS_NOT_VERIFIED_CURRENT` — owner: engineering after protocol evidence; requires fork/replay and executable quotes.
- `BOUND_PRODUCTION_AUTHORIZATION_NOT_CREATED` — owner: launch operations; requires the final Factory/Profile plus an unexpired <=7-day AuthorizationRecord bound to the exact config/wallet/budget scope.
- `EXECUTION_SERVICES_DISABLED_INACTIVE_NO_PROFILE_AUTHORIZATION_OR_MARKERS` — owner: engineering/operations after protocol evidence and explicit owner instruction; the artifacts and units are installed, but signer readiness, SQLite WAL/lease, vault, entry and exit services remain deliberately disabled, and both paid-RPC and production-arm markers are absent.
- `ACTIVE_REGION_PERFORMANCE_NOT_BENCHMARKED` — owner: operations; the selected `us-west-1` host is healthy, but no reproducible multi-region WSS/RPC comparison has selected an optimal active-executor region.
- `NO_V2_CANONICAL_ENTRY_OR_EXIT_RECEIPT` — owner: event/runtime; can be resolved only by a real authorized event and canonical economic effects.

Until every pre-execution blocker is resolved, the default live entrypoint must remain fail-closed. Public Control currently returns `/health=200`, `/ready=503`, and `/dashboard=200`; the `503` truthfully represents `hotArmed=false`, Factory `UNKNOWN`, entry disabled and no verified mainnet exit route. The current deployment boundary is recorded in [2026-08-17-public-rpc-control-deployment.md](./2026-08-17-public-rpc-control-deployment.md); the earlier paid-monitoring stop remains historical evidence in [2026-08-17-rpc-monitoring-pause.md](./2026-08-17-rpc-monitoring-pause.md).
