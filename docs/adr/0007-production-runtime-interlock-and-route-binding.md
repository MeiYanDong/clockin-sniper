# ADR 0007: Production runtime interlock and launch-bound routes

- Status: Accepted
- Date: 2026-08-17
- Owners: project owner and engineering
- Related specification: [plan.md — as-built production runtime](../plan.md#33-as-built-production-runtime-2026-08-17)

## Context

The v2 domain engine already modeled ten one-shot entry lanes, same-raw broadcasting, UNKNOWN recovery, per-wallet positions, and principal-first exits. A production process still needed to connect those modules without weakening the evidence boundary. The final Launcher may emit a different pool address for each token, so a launch-pool exit cannot be safely represented by a guessed fixed router. Process restarts and failures between signing and broadcast also create a narrow but material nonce-ownership window.

The official mainnet Launcher Factory, ClockIn CA, final ABI, and verified exit route remain unpublished. Production code may be installed ahead of time, but it must not become spend-authorized from fixture values or deployment state alone.

## Decision

### Immutable profile and authorization

- A `ProductionProtocolProfile` binds chain `4663`, Factory address and runtime/proxy identity, exact launch event layout, mechanism getters, token/pool code-hash allowlists, buy calldata semantics, and one or more executable exit routes.
- The supported ClockIn mechanism is exact: initial fee `4000 bps`, floor `0 bps`, linear window `120 seconds`. A nearby value is a different profile and fails closed.
- A production authorization is valid for no more than seven days and binds the profile hash, strategy config hash, public wallet manifest, identity gate, and 50U/60U risk envelope.
- Profile or authorization drift is checked again in the execution process; Control Plane status alone cannot authorize spending.

### Launch-bound route resolution

- A fixed reviewed external router uses `targetMode=FIXED`.
- A per-launch internal pool uses `targetMode=LAUNCH_POOL` and resolves its target only from the frozen `LaunchIdentity` emitted by the verified Factory.
- Allowance spender and path construction are explicit profile fields. Dynamic token paths may prepend only the frozen launch token.
- Runtime bytecode is checked against the profile at the quote block. Quotes must represent executable proceeds before wallet Gas; the valuator subtracts approval and sell Gas before policy decisions.

### Process and dispatch interlock

- `clockin-executor`, `clockin-reconciler`, and `clockin-exit` are separate production entrypoints sharing SQLite WAL state and fenced wallet ownership.
- Before any lane is signed, Executor requires fresh local Reconciler and Exit status, matching profile/authorization IDs, 10 signers, WAL readiness, zero unresolved attempts, and enabled reconciliation/exit capability.
- systemd starts Executor only behind the root-owned `PRODUCTION_ARM_APPROVED` marker and orders it after Reconciler and Exit. The application-level interlock is still authoritative.
- All services use systemd notification/watchdog heartbeats and publish only atomic, redacted status files through a shared status group.

### Append-only recovery boundary

- Execution plans, transaction attempts, route quotes, and exit plans append revisions instead of overwriting history.
- A plan hash identifies immutable economic/calldata content and therefore remains the same across state-only revisions; persistence permits that repeated hash.
- Before any provider submission, a proven local failure releases the nonce and capital reservation, invalidates the plan, removes the encrypted payload, and records a terminal dropped attempt when one exists.
- Once submission may have occurred, the nonce remains fenced, the exact signed payload remains encrypted, and Reconciler alone proves receipt, deterministic rejection, or continued UNKNOWN state. No replacement with a different payload is allowed.
- Exit never liquidates from a partial aggregate valuation: any unvalued open lot holds the aggregate policy decision and raises readiness evidence.

## Consequences

- The production execution path is implemented and testable without a Shadow mode.
- Installing the artifact or systemd units is not `HOT_ARMED`; missing final protocol evidence, current authorization, or the arm marker keeps signing and broadcast disabled.
- Launch-pool exits remain bound to the actual frozen pool instead of a placeholder router.
- Recovery preserves both economic history and nonce safety across process crashes.
- Final Factory/ABI evidence, fork/replay, active-region benchmark, and a current readiness receipt remain mandatory before starting the execution services.

## Evidence

Automated tests cover exact 4000-to-0/120-second profile parsing, seven-day authorization, frozen identity/code-hash binding, native buy and launch-pool exit calldata, append-only plan/attempt/quote/exit revisions, service dependency interlocks, watchdog notifications, credential isolation, redacted status, and deterministic lease release.
