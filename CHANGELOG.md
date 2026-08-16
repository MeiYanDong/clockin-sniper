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

### Changed

- Extended the verification command to include formatting, linting, coverage, production dependency audit, and package-content audit.
- Changed the default live entrypoint to fail closed while required mainnet evidence is unavailable; legacy single-wallet commands are explicitly audit/replay-only.
- Reserved per-wallet Gas for one entry, one approval and three sells plus 30% margin; aggregate readiness now enforces the all-in cap and rejects automatic top-up.
- Raised the tested baseline to 207 passing tests with line `89.58%`, branch `72.27%`, and function `94.70%` coverage.

### Security

- Kept generated wallet keys outside the repository with owner-only permissions and a public-address-only manifest.
- Prevented release archives from containing legacy live entrypoints, source/test trees, key-shaped files, authenticated RPC endpoints, or signed raw transactions.
