# Security and release audit — 2026-08-16

## Result

- Evidence level: `repository_record + locally_tested + extracted_archive_verified`
- Unexplained high-severity findings: `0`
- Production deployment security: `NOT_VERIFIED_NOT_DEPLOYED`

## Checks

| Check | Result |
| --- | --- |
| Current repository tree secret scan | PASS |
| Pre-existing Git history scan | PASS, 89 unique text blobs; scanner reports only path/rule and never secret contents |
| Git diff whitespace/error check | PASS |
| Biome format/lint and strict TypeScript | PASS |
| Tests and coverage gates | PASS, 197/197; line 89.46%, branch 72.68%, function 94.62% |
| Production dependencies | PASS, `npm audit --omit=dev --audit-level=high` reported 0 vulnerabilities |
| `npm pack --dry-run` | PASS |
| Extracted archive boundary/secret scan | PASS, 247 files |
| Release-candidate SHA-256 | `782a56998e1bce274ef7d81db9c26b611a1ee242559e474a32449912a5ccfcff` for the local pre-commit candidate only; not a published artifact |
| Legacy live/source/test exclusion | PASS |
| systemd credential boundary | PASS for templates: keyless Control, exactly ten entry credentials only for executor/exit, owner-only directories, non-root users, `ProtectProc=invisible` |
| SQLite/vault permissions | PASS in tests: database and encrypted raw-transaction vault mode 0600 |
| Journal/dashboard/alerts | PASS in tests: raw/key/RPC fields redacted; transport acceptance never displayed as a fill |

## Accepted/open risks

- The local runtime was Node 25, while CI/release is pinned to Node 24; only the committed CI run is release evidence.
- Final mainnet contract identities and adapters are unavailable. This is an authorization blocker, not an accepted execution risk.
- Generated entry wallets are unfunded. No funding or key material is in the repository.
- No cloud host exists, so actual systemd credential mounts, `/proc`, journal retention, service readback and watchdog heartbeat remain unverified.
- No live transaction was signed or broadcast. There is no live receipt/economic effect to audit.

The archive checksum above identifies a disposable local candidate built before the final Git commit. Release workflow artifacts must have their own checksum and `BUILD-METADATA.json` tied to the committed source SHA.
