# ADR 0008: Public observation and paid execution RPC boundary

- Status: Accepted
- Date: 2026-08-17
- Owners: project owner and engineering
- Related specification: [plan.md — RPC cost and capability boundary](../plan.md#34-rpc-cost-and-capability-boundary-2026-08-17)

## Context

The original Control Sentinel loaded authenticated Chainstack HTTP/WSS credentials and refreshed wallet readiness every five seconds. One refresh performed two identity calls, one gas-price call, and three calls for each of ten wallets, or about 34 paid RPC calls before WSS-triggered work. Even without WSS callbacks this implied at least 587,520 paid calls per day. The owner stopped the service after observing excessive Chainstack consumption.

The operational requirement is now exact: continuous pre-launch observation may use the official Robinhood public RPC, while Chainstack may be used only after the owner deliberately begins a real-snipe preparation window and while transactions, reconciliation, or exits may still require it. A website change, name match, candidate CA, address-cluster event, or other soft signal must never activate paid transport or signing by itself.

## Options considered

### Keep authenticated RPC continuously connected

This provides lower transport latency and WSS delivery before a launch, but violates the approved cost boundary and recreates unbounded background consumption.

### Automatically switch to Chainstack on a soft signal

This may reduce the delay between discovery and paid readiness. It also lets untrusted or ambiguous observations cause cost, makes false positives operationally expensive, and blurs observation with authorization.

### Public Control plus explicitly approved paid execution window

This preserves continuous low-cost discovery and makes paid capability a deliberate, auditable state transition. It accepts that a public HTTP poll can be slower or rate-limited and therefore cannot promise first-block inclusion.

## Decision

### Always-on Control

- `clockin-control` has exactly one chain transport: the hard-coded official public HTTP endpoint `https://rpc.mainnet.chain.robinhood.com`.
- Control accepts no RPC URL from environment, command line, strategy configuration, or systemd credentials. Its unit has no `LoadCredential` directive and reads only `/etc/clockin-sniper/control.env`, which may contain non-sensitive timing and local HTTP/status settings.
- The cold cadence is a two-second head poll, five-minute chain-identity recheck, hourly public wallet-readiness refresh, and thirty-second website fingerprint refresh. Each JSON-RPC method call is counted in the Control snapshot.
- Public monitoring is observation evidence only. It cannot sign, broadcast, create an authorization, create an approval marker, or start another service.

### Paid RPC window

- `clockin-executor`, `clockin-reconciler`, and `clockin-exit` retain authenticated RPC credentials, but systemd refuses to start them unless `/etc/clockin-sniper/PAID_RPC_APPROVED` exists.
- Each process validates that the marker is a regular root-owned, non-group/world-writable file containing exactly `CLOCKIN_PAID_RPC_APPROVED_V1` before reading a paid RPC credential.
- The marker authorizes paid transport cost only. Executor additionally requires `/etc/clockin-sniper/PRODUCTION_ARM_APPROVED`, a current immutable profile and authorization, ten-wallet readiness, Reconciler/Exit readiness, and all application-level interlocks before it may sign or broadcast.
- Neither marker is created automatically. Opening the paid window requires an explicit owner decision to prepare for a real snipe. A soft signal may alert the owner but cannot cross the boundary.
- While any transaction outcome is `UNKNOWN` or any position remains open, Reconciler/Exit and the paid marker must remain available. After all attempts are terminal and exposure is zero, stop the three paid services first and then remove the paid marker.

## Consequences

### Positive

- Ordinary 24×7 monitoring produces zero Chainstack requests by construction.
- Paid endpoint cost and signing authority are separate, auditable capabilities.
- A compromised website or false-positive candidate cannot automatically activate paid transport or move funds.
- The snapshot makes public request cadence and method counts observable.

### Negative

- Cold observation uses HTTP polling rather than paid WSS and may see a block up to the configured polling interval later, plus provider/network variance.
- The paid provider is not pre-warmed from soft signals. Human approval and service startup add latency, so this mode deliberately gives up some FCFS competitiveness to satisfy the cost rule.
- The official public endpoint is rate-limited and not an appropriate execution transport; it is never used for signing/broadcast fanout.

### Follow-up evidence

- Automated tests must prove Control cannot be configured to another RPC and has no paid credential mount.
- Deployment readback must prove Control is the only active process, has no credentials directory or RPC environment variables, reports `OFFICIAL_PUBLIC_HTTP_ONLY`, and advances its public request counters.
- Deployment readback must also prove all paid services are disabled/inactive and both approval markers are absent.
