# ClockIn v2 implementation receipt — 2026-08-16

## Outcome

- Evidence level: `implemented + locally_tested + package_boundary_verified`
- Implementation commit: `eb38052c487b8cf1b14460a7b8dce87c766f5d20`
- Production state: `NOT_HOT_ARMED`
- Test result: `197/197` passing.
- Coverage: line `89.46%`, branch `72.68%`, function `94.62%`.
- Enforced coverage floors: line `85%`, branch `60%`, function `80%`.
- Default live entrypoint: fail-closed; exit code `2`, `signed=false`, `broadcast=false`.
- Public release PR: [#5](https://github.com/MeiYanDong/clockin-sniper/pull/5).
- Required CI run: [31940291085](https://github.com/MeiYanDong/clockin-sniper/actions/runs/31940291085), both jobs passed.
- Negative-control gate: temporary PR #6 / run [31940391409](https://github.com/MeiYanDong/clockin-sniper/actions/runs/31940391409) failed specifically at `format:check`; the PR was closed and the temporary branch deleted.

The implementation includes the canonical v2 model and state machine, SQLite WAL persistence, known/topic-wide/address/website Control channels, immutable identity and L0–L4 authorization, ten independent one-shot EOA lanes, fee-band planning, canary calibration, quote-bounded plans, same-raw broadcast and UNKNOWN recovery, receipt/effect/reorg reconciliation, position/route/exit policy, readiness/dashboard/alerts, failover, benchmark primitives, systemd templates, and release boundary checks.

## Wallet evidence

- Ten repository-external entry wallets were generated.
- External secret directory mode was verified as `0700`; individual key files as `0600`.
- Address/key correspondence was verified `10/10` without printing or storing private keys in the repository.
- Wallets are not funded, and no public repository file contains key paths or key material.

## Release boundary evidence

An actual `npm pack` archive was built and extracted. The audit required build metadata, capability manifest, `dist/v2-index.js`, and `dist/live-v2.js`; it rejected legacy live entrypoints, `src/`, `test/`, secret-shaped filenames, authenticated RPC endpoints, private keys, seed phrases, and signed raw transactions. The resulting local archive passed with 247 files; CI repeats the check against the committed tree.

The committed source tree and Git history secret scans passed. Release metadata records source commit, Node version, package version, capability manifest revision, and its SHA-256.

The public PR's required quality job completed successfully and wrote the test/coverage evidence to its GitHub Actions job summary. A separate disposable negative-control branch proved that a one-line formatting drift returns a non-zero CI result before merge; no negative-control file or branch remains in the product tree.

## Evidence boundary

This receipt does not prove final mainnet contract identity, funded readiness, cloud deployment, a signed or broadcast transaction, a canonical receipt, an executable final mainnet exit, or positive expected value. Those remain separate gates in `docs/todo.md`.
