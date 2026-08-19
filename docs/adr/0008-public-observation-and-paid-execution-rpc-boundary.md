# ADR 0008: Public observation and paid execution RPC boundary

- Status: Accepted
- Date: 2026-08-17
- Owners: project owner and engineering
- Related specification: [plan.md — RPC cost and capability boundary](../plan.md#34-rpc-cost-and-capability-boundary-2026-08-17)

## Context

The original Control Sentinel loaded authenticated Chainstack HTTP/WSS credentials and refreshed wallet readiness every five seconds. One refresh performed two identity calls, one gas-price call, and three calls for each of ten wallets, or about 34 paid RPC calls before WSS-triggered work. Even without WSS callbacks this implied at least 587,520 paid calls per day. The owner stopped the service after observing excessive Chainstack consumption.

The operational requirement is now exact: continuous pre-launch observation may use a compiled,
keyless public-RPC pool, while Chainstack may be used only after the owner deliberately begins a
real-snipe preparation window and while transactions, reconciliation, or exits may still require it.
A website change, name match, candidate CA, address-cluster event, or other soft signal must never
activate paid transport or signing by itself.

## Options considered

### Keep authenticated RPC continuously connected

This provides lower transport latency and WSS delivery before a launch, but violates the approved cost boundary and recreates unbounded background consumption.

### Automatically switch to Chainstack on a soft signal

This may reduce the delay between discovery and paid readiness. It also lets untrusted or ambiguous observations cause cost, makes false positives operationally expensive, and blurs observation with authorization.

### Public Control plus explicitly approved paid execution window

This preserves continuous low-cost discovery and makes paid capability a deliberate, auditable state transition. It accepts that a public HTTP poll can be slower or rate-limited and therefore cannot promise first-block inclusion.

## Decision

### Always-on Control

- `clockin-control` has one compiled keyless transport pool: Robinhood's official public HTTP endpoint
  is primary and the fixed BlockReq Robinhood public route is the bounded fallback. Neither endpoint
  is accepted from environment, command line, profile or credentials.
- Control accepts no RPC URL from environment, command line, strategy configuration, or systemd credentials. Its unit has no `LoadCredential` directive and reads only `/etc/clockin-sniper/control.env`, which may contain non-sensitive timing and local HTTP/status settings.
- The cold cadence is a two-second head poll, five-minute chain-identity recheck, hourly public wallet-readiness refresh, and thirty-second website fingerprint refresh. Head and identity tasks use independent in-process overlap guards so their aligned timer periods cannot suppress identity rechecks. All physical public JSON-RPC calls still share one serialized 500 ms minimum-interval queue. A transient failure on the official route opens a sixty-second circuit and immediately moves the request to the fixed keyless fallback; transient fallback failures receive at most two retries with one- and two-second backoff. Each physical request, route, failover and throttled retry is counted in the Control snapshot.
- Public monitoring is observation evidence only. It cannot sign, broadcast, create an authorization, create an approval marker, or start another service.

### Paid RPC window

- `clockin-executor`, `clockin-reconciler`, and `clockin-exit` retain authenticated RPC credentials, but systemd refuses to start them unless `/etc/clockin-sniper/PAID_RPC_APPROVED` exists.
- Each paid process validates that the marker is an exact `root:clockin 0440` regular file containing `CLOCKIN_PAID_RPC_APPROVED_V1` before reading a paid RPC credential. Root remains the sole writer/revoker; group read exists because paid units run as `clockin`, while the keyless `clockin-observer` identity is deliberately outside that group.
- The marker authorizes paid transport cost only. Executor additionally requires `/etc/clockin-sniper/PRODUCTION_ARM_APPROVED`, a current immutable profile and authorization, ten-wallet readiness, Reconciler/Exit readiness, and all application-level interlocks before it may sign or broadcast.
- Neither marker is created automatically. Opening the paid window requires an explicit owner decision to prepare for a real snipe. A soft signal may alert the owner but cannot cross the boundary.
- While any transaction outcome is `UNKNOWN` or any position remains open, Reconciler/Exit and the paid marker must remain available. After all attempts are terminal and exposure is zero, stop the three paid services first and then remove the paid marker.

## Consequences

### Positive

- Ordinary 24×7 monitoring produces zero Chainstack requests by construction.
- Paid endpoint cost and signing authority are separate, auditable capabilities.
- A compromised website or false-positive candidate cannot automatically activate paid transport or move funds.
- The snapshot makes public request cadence, method counts, and throttled retries observable.

### Negative

- Cold observation uses HTTP polling rather than paid WSS and may see a block up to the configured polling interval later, plus provider/network variance.
- The paid provider is not pre-warmed from soft signals. Human approval and service startup add latency, so this mode deliberately gives up some FCFS competitiveness to satisfy the cost rule.
- Both public routes are best-effort observation transports, not execution transports. Neither is
  used for signing/broadcast fanout, and the paid Executor independently revalidates every handoff
  against Chainstack before any signature.

### Follow-up evidence

- Automated tests must prove Control cannot be configured outside the compiled keyless pool and has
  no paid credential mount.
- Deployment readback must prove Control is the only active process, has no credentials directory or
  RPC environment variables, reports `KEYLESS_PUBLIC_HTTP_FAILOVER`, advances its per-route counters,
  and completes canonical handoff catch-up without an unresolved public-RPC failure.
- Deployment readback must also prove all paid services are disabled/inactive and both approval markers are absent.

## Follow-up note — 2026-08-20

[ADR 0010](0010-bounded-canary-and-staged-expansion.md) narrows the readiness clause above for exactly one maximum-5U bounded canary. That canary still requires the paid-RPC marker, production-arm marker, current immutable profile/authorization, the authorized ten-key manifest, `entry-01` funding/nonce readiness, current Reconciler/WAL state and zero unresolved attempts; it does not require Exit readiness or funding/exit-Gas readiness for wallets 2–10. The original ten-wallet and Reconciler/Exit readiness clause remains fully in force before lanes 2–10.

[ADR 0011](0011-public-handoff-and-weth-quoted-production-hotpath.md) supersedes that historical
startup/readiness detail for the verified CLOCKIN WETH-quoted launch. Public exact-chain handoff now
starts the paid plane through `clockin-executor.path`; paid services do not prewarm. Wallet preparation
is completed before the path is enabled, and lanes 2–10 require canonical canary reconciliation plus
readiness of the remaining wallets, not official X confirmation or Exit readiness. Executor,
Reconciler and Exit continuously validate both runtime markers and have finite paid lifecycles.
