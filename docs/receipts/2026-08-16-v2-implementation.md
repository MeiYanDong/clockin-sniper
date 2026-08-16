# ClockIn v2 implementation receipt — 2026-08-16

## Outcome

- Evidence level: `implemented + locally_tested + package_boundary_verified`
- Production state: `NOT_HOT_ARMED`
- Test result: `197/197` passing.
- Coverage: line `89.46%`, branch `72.68%`, function `94.62%`.
- Enforced coverage floors: line `85%`, branch `60%`, function `80%`.
- Default live entrypoint: fail-closed; exit code `2`, `signed=false`, `broadcast=false`.

The implementation includes the canonical v2 model and state machine, SQLite WAL persistence, known/topic-wide/address/website Control channels, immutable identity and L0–L4 authorization, ten independent one-shot EOA lanes, fee-band planning, canary calibration, quote-bounded plans, same-raw broadcast and UNKNOWN recovery, receipt/effect/reorg reconciliation, position/route/exit policy, readiness/dashboard/alerts, failover, benchmark primitives, systemd templates, and release boundary checks.

## Wallet evidence

- Ten repository-external entry wallets were generated.
- External secret directory mode was verified as `0700`; individual key files as `0600`.
- Address/key correspondence was verified `10/10` without printing or storing private keys in the repository.
- Wallets are not funded, and no public repository file contains key paths or key material.

## Release boundary evidence

An actual `npm pack` archive was built and extracted. The audit required build metadata, capability manifest, `dist/v2-index.js`, and `dist/live-v2.js`; it rejected legacy live entrypoints, `src/`, `test/`, secret-shaped filenames, authenticated RPC endpoints, private keys, seed phrases, and signed raw transactions. The resulting local archive passed with 247 files; CI repeats the check against the committed tree.

The current source tree and pre-existing Git history secret scans passed. Release metadata records source commit, Node version, package version, capability manifest revision, and its SHA-256.

## Evidence boundary

This receipt does not prove final mainnet contract identity, funded readiness, cloud deployment, a signed or broadcast transaction, a canonical receipt, an executable final mainnet exit, or positive expected value. Those remain separate gates in `docs/todo.md`.
