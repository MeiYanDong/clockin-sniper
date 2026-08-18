# Control hardening deployment and real-snipe arming audit — 2026-08-18

## Evidence level and decision

`DEPLOYED_PUBLIC_CONTROL_HARDENED / STATIC_EXECUTION_PREREQUISITES_STAGED / NOT_HOT_ARMED / ZERO_VALID_TRANSACTION`

The owner explicitly requested real-production hardening and arming. This receipt records everything that could be prepared without inventing the unpublished protocol identity. It proves a new public-only Control deployment and a current negative HOT arming decision. It does not prove a trade, an executable final Factory profile or positive expected value.

## Immutable artifact and CI

| Item | Verified value |
|---|---|
| Source commit | `e1fb6eb2dabc88ce45974032be4a82c6170bc07c` |
| Public branch | `agent/keyless-control-production-deployment` |
| GitHub PR | draft PR #10, mergeable |
| GitHub Actions | run `32101353060`, both required checks passed |
| Package | `local-clockin-sniper-0.1.0.tgz` |
| Package SHA-256 | `9c741ea6e13e5e1ca418b7b549a8fb7997a1b398cc66ffa59a0d4369592fa00f` |
| Capability manifest | revision `10`, SHA-256 `25b63813bce599e803e35b5dfbcef33702baa21c22278d910ac4e4dade5295aa` |
| Installed Control entrypoint SHA-256 | `5c8d8be0d67fa982bc0896bca3620bb4e98502d02f8310756834a3b85b6a5427` |
| Local verification | 240/240 tests; line 89.00%, branch 68.84%, function 92.04%; secret/history, format, lint, typecheck, production audit and package audit passed |
| Production release | `/opt/clockin-sniper/releases/e1fb6eb2dabc88ce45974032be4a82c6170bc07c` |

The package checksum and `BUILD-METADATA.json` were independently read back after upload and before extraction. The server installed nine locked production packages with the versioned Node `v24.19.0` runtime. The old release `2a5e9e3586a395b62731b961bb97087ab96786a5` and the pre-change units under `/opt/clockin-sniper/unit-backups/2026-08-18T0505Z-before-e1fb6eb/` remain available for rollback.

## Deployed Control behavior

The new Control started at `2026-08-18T05:05:23Z`. Initial readback reported:

- `clockin-control`: enabled, active/running, PID `328174`, `NRestarts=0`, 30-second watchdog advancing;
- `/health=200`, `/ready=503`, `/dashboard=200`; 503 is the correct negative HOT result;
- 10/10 wallets ready, 10/10 latest/pending nonce-clean and all-in cap ready at `2026-08-18T05:05:40Z`;
- chain head `39433707` and advancing on chain `4663`;
- public RPC physical counts after startup: 43 total, 11 foreground and 32 background, zero throttle retry, zero pending queue and maximum background queue depth 29;
- monitoring policy remained `OFFICIAL_PUBLIC_HTTP_ONLY`, 500ms global minimum interval and `paidRpcCapability=false`.

The production semantic page snapshot correctly separated page scopes:

```text
clockin.win/                       status=UNKNOWN     candidates=0 clockInMentioned=true
stonkbrokers.cash/launcher        status=COMING_SOON candidates=0 markers=COMING_SOON,SIGNAL_SCRAMBLED,SAFE_LAUNCH_OPEN
stonkbrokers.cash/safe-launch     status=UNKNOWN     candidates=0
```

The startup journal contained three `INFO` baselines and zero `ACTION`/`ERROR` events. In particular, the live Safe Launch marker on the Launcher page did not promote the main Launcher to `OPEN`. Automated tests separately prove that framework-only raw HTML changes create no action and that a foreground head request takes the next physical slot ahead of queued background readiness work.

A held readback through `2026-08-18T05:11:45Z` showed head progression from `39433707` to `39437158`, `lastIdentityCheckAt=2026-08-18T05:10:40.934Z`, `eth_chainId=3`, 218 total public requests (186 foreground / 32 background), zero throttled retry, zero `ACTION`, zero application `ERROR`, `NRestarts=0`, and an advancing watchdog. This proves the first scheduled five-minute identity recheck on the deployed artifact while normal head polling continued.

## RPC and secret capability boundary

- The Control process had zero environment variable names matching RPC, Chainstack, credential, private-key, mnemonic or wallet-key fields.
- `/run/credentials/clockin-control.service` was absent.
- Executor, Reconciler and Exit point to the new immutable artifact but remain `disabled/inactive`, PID 0.
- `PAID_RPC_APPROVED` and `PRODUCTION_ARM_APPROVED` remained absent throughout.
- Existing authenticated HTTP/WSS credential contents were not read and were not probed. No Chainstack request was made during this deployment or audit.
- No private key, mnemonic, vault key, authenticated endpoint, signed raw transaction or valid transaction payload was printed.

## Static execution prerequisites staged

Two prerequisites independent of the final Factory were safely completed:

1. A fresh 32-byte signed-transaction vault key was generated outside the repository, stored in the local external secret tree with directory/file modes `0700/0600`, and installed as `/etc/clockin-sniper/credentials/vault_key` with `0400 root:root`. Its value was never displayed.
2. The official Robinhood mainnet Sequencer credential was installed as `0400 root:root`. At `2026-08-18T05:09:09Z`, a deterministic invalid-empty-transaction probe confirmed the write method rejects the invalid payload. The probe had `signed=false` and sent no valid transaction.

These files are capabilities needed by future paid services; their presence does not authorize or start those services.

## Current HOT arming gate audit

| Gate | Current evidence | Result |
|---|---|---|
| Owner real-snipe preparation intent | Explicit request received in this task | PASS |
| Official mainnet Factory / event profile | Official Launcher and docs still say Coming Soon; no mainnet Launcher Factory address; testnet archive explicitly excluded | BLOCKED |
| Final buy/fee/cap/window/finalize ABI | Only upcoming function names are public; no exact final ABI/runtime binding | BLOCKED |
| ClockIn CA / pool identity | Official fallback pages expose zero candidate address | BLOCKED |
| Immutable production profile | `/etc/clockin-sniper/credentials/factory-profile.json` absent | BLOCKED |
| <=7-day bound authorization | `/etc/clockin-sniper/credentials/production-authorization.json` absent | BLOCKED |
| Wallet key files | Exactly ten root-only entry key files remain present; values not read | PASS static |
| Wallet public funding/nonces | 10/10 ready and nonce-clean in the post-deploy public snapshot | PASS at `2026-08-18T05:05:40Z` |
| Vault key | External backup plus server `0400 root:root` credential | PASS static |
| Direct Sequencer | Credential staged; invalid-payload rejection verified | PASS current read-only/write-method semantics |
| Paid HTTP/WSS | Credentials exist, but current health intentionally not probed before a valid target/profile exists | NOT ACTIVATED |
| Price | Cold snapshot expires after 30 seconds by policy | BLOCKED for HOT; must refresh immediately before entry |
| SQLite WAL / writer lease | `/var/lib/clockin-sniper/canonical.sqlite` absent because execution has never been activated | BLOCKED |
| Inner / external exit routes | No final profile-bound executable sell route | BLOCKED |
| Reconciler / Exit readiness | Both inactive because profile/authorization gates fail | BLOCKED |
| Exposure | Control reports zero unresolved attempts and zero open positions | PASS |
| Arm markers | Both absent | CORRECT FAIL-CLOSED RESULT |

The deployed fail-closed entrypoint returned exit code `2`, `state=NOT_HOT_ARMED`, `signed=false`, `broadcast=false`, and the exact blocker list from capability revision 10.

## Decision

Do not create either marker and do not start a paid service yet. The first blocking fact is not operational caution but missing transaction identity: without an official mainnet Factory/runtime/event profile and executable exit route, the program cannot know what event authorizes purchase, what calldata buys, how the actual 40%→0% schedule is read, or how received tokens can be sold.

The production state is now stronger than before: high-signal public observation is deployed; the ten wallets, vault encryption material and direct Sequencer credential are staged; paid credentials remain dormant. The next legitimate transition is triggered by an official mainnet Factory/ABI publication, followed by exact-block verification, fork/replay, immutable profile generation and a current <=7-day authorization. Only then should the paid window be opened and the 30-second price/readiness gates evaluated.
