# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project intends to use Semantic Versioning once its first release boundary is frozen.

## [Unreleased]

### Added

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

### Changed

- Extended the verification command to include formatting, linting, coverage, production dependency audit, and package-content audit.
- Changed the default live entrypoint to fail closed while required mainnet evidence is unavailable; legacy single-wallet commands are explicitly audit/replay-only.
- Reserved per-wallet Gas for one entry, one approval and three sells plus 30% margin; aggregate readiness now enforces the all-in cap and rejects automatic top-up.
- Raised the tested baseline to 240 passing tests; the latest full verification reported line `89.00%`, branch `68.84%`, and function `92.04%` coverage.
- Updated operational truth: all ten production wallets last reported funded with clean nonces; revision-10 keyless Control is enabled/active with semantic site signals, priority public scheduling, no paid capability and a progressing watchdog; the vault key and official Sequencer credential are staged root-only, while Executor/Reconciler/Exit remain disabled/inactive because the final mainnet Factory/ABI/profile/authorization/exit route is unavailable.

### Security

- Kept generated wallet keys outside the repository with owner-only permissions and a public-address-only manifest.
- Prevented release archives from containing legacy live entrypoints, source/test trees, key-shaped files, authenticated RPC endpoints, or signed raw transactions.
