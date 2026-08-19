# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project intends to use Semantic Versioning once its first release boundary is frozen.

## [Unreleased]

### Added

- Verified CLOCKIN WETH quoted-pad adapter and discovery path: exact pad and approved creator `LaunchCreated` filtering, same-id `LaunchArmed` correlation, dynamic `getLaunch/currentTaxBps/quoteBuy` reads, and nonpayable `buy(id, quoteIn, minTokensOut, ref)` construction.
- WETH principal readiness and preparation planning for ten 5U lanes, including native-Gas separation, exact/bounded allowance checks, and fail-closed `0 WETH / 0 allowance` reporting.
- A real-funds quoted Executor implementation and tests, plus repository-external immutable profile and seven-day authorization rendering. These are local artifacts and do not constitute production deployment or a live transaction receipt.
- A public exact-metadata/block-hash handoff with two-block confirmation, immutable reorg tombstones, cursor rewind/replacement and reboot-safe `clockin-executor.path` activation.
- Durable WETH preparation recovery, retryable same-nonce execution-plan revisions, restart restoration of spent lanes, and finite Executor/Reconciler/Exit paid lifecycles with continuous marker checks.
- Valid-only `active.signal` activation, durable `<=2,000`-block public cursor checkpoints with a caught-up readiness gate, and public late-`LaunchArmed` retrigger after the bounded paid wait exits.
- Armed-oracle `quoteUsd8` principal conversion rounded down to at most 5U per lane, with external price providers removed from the event-to-sign hot path.
- Ten-percent preparation reserves, preparation-time and Armed-time 60U all-in gates, and `deadline-1` fee-floor enumeration that supports executable 0 bps and non-divisible decay schedules.
- Immediate pre-sign marker/canonical-block/quote/base-fee revalidation and proven-prebroadcast-only crash release; any possible broadcast remains same-raw reconciliation only.
- Armed-wait handoff replacement monitoring, conservative UNKNOWN-by-default provider classification, UMask-safe handoff permissions, and cross-restart preparation receipt/Gas accounting.
- Complete ClockIn production-system technical specification.
- Executable phased backlog with story cards, checkboxes, tests, and acceptance criteria.
- Public-repository scope and secret-boundary documentation.
- Biome formatting and linting baseline.
- Enforced test coverage thresholds.
- GitHub CI and release-delivery workflows.
- Pull-request, issue, contribution, security, and ADR templates.
- Canonical v2 domain model, state machines, SQLite WAL persistence, migrations, reservations, nonce slots, service leases, and legacy NDJSON audit import.
- Known/topic-wide/address-cluster/website Control Sentinel channels with exact-block Factory fingerprinting and a fail-closed profile registry.
- Ten independent one-shot EOA wallet lifecycle, readiness, price snapshots, fee-band planning, canary calibration, catch-up scheduling, and quote-bounded execution plans.
- Same-raw provider fanout, encrypted UNKNOWN recovery, receipt/economic-effect reconciliation, reorg revisions, latency timelines, positions, route valuation, and principal-first exit policy.
- Health/readiness endpoints, evidence-only dashboard, asynchronous redacted alerts, single-writer failover, region benchmark tooling, hardened systemd templates, and deployment runbooks.
- Build metadata, Git-history secret scanning, extracted-archive boundary scanning, and v2-only package exports.
- `clockin-policy-v2` with a 50U principal/60U all-in envelope, 1U–5U cap resizing, dual-source price bounds, and seven-day scope-bound authorization.
- Pre-principal executable-net stop/holding policy and a separately authorized 20% break-glass exit path while routine exits remain capped at 5%.
- Immutable production protocol profiles and seven-day authorizations, exact configured Factory/Pool adapters, dynamic launch-bound exit targets, and production Executor/Reconciler/Exit entrypoints.
- Append-only execution/attempt/route/exit revisions, deterministic pre-broadcast cleanup, UNKNOWN same-raw recovery, cross-service readiness interlocks, redacted status exchange, watchdog heartbeats, and deterministic systemd rendering.
- Fail-closed production deployment receipt covering all four entrypoint hashes, unit state, 30-second watchdog readback, OS secret boundary, failed-start containment and recoverable rollback.
- Hard-coded official-public HTTP Control transport with per-method request metering, a credential-free `control.env`, and a separately approved paid-RPC window for real-snipe preparation/reconciliation/exit.
- Root-owned `PAID_RPC_APPROVED` interlock validated before Executor, Reconciler, or Exit reads a paid RPC credential; this cost approval remains independent from `PRODUCTION_ARM_APPROVED` signing authority.
- Serialized public-RPC pacing with a 500 ms minimum interval, bounded 429 backoff, and physical-request/retry metering so hourly wallet readiness does not burst through the official endpoint's rate limit.
- Independent head-poll and chain-identity overlap guards so the aligned 2-second/5-minute timers cannot suppress periodic network-identity verification.
- Dual raw/semantic official-site observations that ignore framework-only byte churn, preserve explicit launch-status changes, and surface only visible or labelled addresses as unverified candidates.
- Foreground/background scheduling inside the single public-RPC limiter so head and identity requests take the next available physical slot ahead of queued hourly readiness work.
- Public snapshot metering for priority-class request counts, current queue depths, maximum background depth, semantic page states, and unverified candidate sets.
- Scope-bound monitoring of the official documentation address table that accepts only a mainnet-labelled Launcher Factory before the Testnet Archive boundary; all four official page requests run in parallel so the extra fallback does not add serial timeout latency.
- A hash-bound `clockin-bounded-canary-v1` policy that limits early-risk execution to one 5U lane. Its original native-ETH-primary assumption is historical and is superseded by the 2026-08-20 WETH quoted primary path.
- Separate canary/full dependency, wallet and operational readiness tiers, plus a retryable later-lane expansion gate requiring canonical effect, L3 identity, allowlisted code and executable exit evidence.

### Changed

- Replaced the historical “final Factory/ABI unpublished” entry blocker with 2026-08-20 verified quoted-protocol evidence. The production blocker is now deployment/readiness: the server still runs only keyless Control, both approval markers are absent, and all ten wallets still need WETH wrap/allowance preparation.
- Made chain events the execution trigger. X and website observations are asynchronous confirmation/conflict inputs only and never sit on the `LaunchCreated → LaunchArmed → dynamic buy` hot path.
- Corrected the primary principal asset from native ETH to WETH. Native ETH funds WETH deposit and Gas; STONK is not required for the current CLOCKIN primary path.
- Recorded the currently verified defaults as a 300-second `9999 bps` buffer followed by `3300 bps` start tax decaying `100 bps` per minute, while retaining mandatory runtime getter reads rather than hard-coding those values.
- Corrected the final default lane from an unreachable 0% to the last tax buyable before the strict deadline, currently 1%; the value is derived per launch from its decay/window fields.
- Removed Exit readiness as a prerequisite for lanes 2–10; canonical canary effect, fresh Reconciler state, and readiness of the remaining WETH/allowance/nonce/Gas lanes remain mandatory expansion gates.
- Split evidence into `LOCAL_FULL_GATE_PASSED`, launch-before `ENTRY_HOT_ARMED`, and launch-after canonical entry effect; the absence of a real event receipt is a current effect limitation, not a pre-launch entry blocker.
- Declared the generic Exit service unsupported for the quoted profile. Entry may be armed under the accepted risk decision, but automatic exit may not be claimed as armed.
- Extended the verification command to include formatting, linting, coverage, production dependency audit, and package-content audit.
- Changed the default live entrypoint to fail closed until the verified quoted profile is deployed and current production readiness passes; legacy single-wallet commands are explicitly audit/replay-only.
- Replaced the historical generic three-sell Gas readiness assumption for this quoted entry path with buffered WETH plus wrap/approve/entry maximum Gas under the 60U all-in cap.
- Raised the current functional baseline to 386 passing tests; core coverage is line `89.13%`, branch `68.60%`, and function `88.19%`, with a separate production-entrypoint regression gate at line `34.35%`, branch `70.41%`, and function `68.82%`.
- Updated operational truth: all ten wallets have native ETH and clean nonces, but remain `0 WETH / 0 quoted-pad allowance`; revision-11 keyless Control is enabled/active while the quoted artifact/profile/authorization is not deployed, both approval markers are absent, and paid services remain disabled/inactive.
- Changed Executor startup ordering so Reconciler remains mandatory while Exit prewarms in parallel. The earlier rule making missing Exit block lanes 2–10 is superseded: Exit no longer gates entry expansion.
- Removed the unimplemented later-lane no-quote dispatch fallback and made transient pre-sign readiness loss return a lane to `DEFERRED` instead of consuming it as a final failure.

### Security

- Kept generated wallet keys outside the repository with owner-only permissions and a public-address-only manifest.
- Prevented release archives from containing legacy live entrypoints, source/test trees, key-shaped files, authenticated RPC endpoints, or signed raw transactions.
- Added an application-level exact-content/owner/mode validation of `PRODUCTION_ARM_APPROVED` before Executor reads any signer credential.
