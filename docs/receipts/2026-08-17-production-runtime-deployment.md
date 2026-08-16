# Production runtime deployment receipt — 2026-08-17

## Evidence level and decision

`DEPLOYED_FAIL_CLOSED_NOT_HOT_ARMED`

This receipt proves that the production runtime artifact and all four systemd units were installed on the selected host. It does **not** prove a valid Factory/Profile, launch authorization, signed transaction, broadcast, fill, token receipt, or profitable exit. The three services that can touch signing state remain `disabled` and `inactive`; the arm marker is absent.

## Scope

| Item | Verified readback |
| --- | --- |
| Host | `47.251.28.201`, SSH management port `2222` |
| Source commit | `16d02f05a54a33bfd0bb8bbce627b1aef892a689` |
| Immutable release | `/opt/clockin-sniper/releases/16d02f05a54a33bfd0bb8bbce627b1aef892a689` |
| Uploaded artifact SHA-256 | `3152cd2a48ad4cd614fbd6d3ca5fd3e45d1cba1d978c75f3be15384de80844d7` |
| Package version | `0.1.0` |
| Build Node | `v25.9.0` |
| Production runtime Node | `v24.19.0` from a versioned absolute path |
| Capability manifest | revision `5`, SHA-256 `ef2cf99ae60c35c6a1102f8c0c22d0cf2f54b4177ff3e23b6419f9c14e7e194a` |
| Readback window | `2026-08-16T17:07:09Z` through `2026-08-16T17:08:31Z` |

The first stable four-unit deployment used commit `fcbd70ff4c34f8c7d77e24e056de21cdf54434e0` and artifact SHA-256 `7a23dfd2ff43df325e4dada0164daeb761d95cda5b93202987f084807360fab0`. It was then replaced by the metadata-aligned revision 5 artifact above. The entrypoint hashes did not change; only the documented operational capability state advanced.

## Entrypoint integrity

SHA-256 values were recomputed from the installed immutable release:

| Entrypoint | SHA-256 |
| --- | --- |
| `dist/control-service.js` | `d5d2c1cce94a3fd53b6fd3f58db2cff1d00c283c1fb56b7851a6d4b3c90b5265` |
| `dist/executor-service.js` | `78887e6b0ca842011373dac2844e3dcf0b0307ee71c39d9a9b93cd5ca174562c` |
| `dist/reconciler-service.js` | `4cb8fcdb26744dc2950db694a7f9a1dc40bd9d1900ee1784c76ff739e93dde25` |
| `dist/exit-service.js` | `6d9df68da525730243f49ef4c81f66ee97146fdcd8012cf0638c78e320ee1de6` |

Every installed unit points directly to one of these entrypoints and uses the absolute production Node path. Control runs as `clockin-observer`; Executor, Reconciler, and Exit run as `clockin`. All four receive only the `clockin-status` supplementary group needed for redacted status exchange.

## Live service readback

At `2026-08-16T17:08:31Z`:

| Unit | Enabled state | Active state | Authority boundary |
| --- | --- | --- | --- |
| `clockin-control.service` | enabled | active | keyless observation and readiness only |
| `clockin-executor.service` | disabled | inactive | no signing or entry process |
| `clockin-reconciler.service` | disabled | inactive | no signer-backed reconciliation process |
| `clockin-exit.service` | disabled | inactive | no signer-backed exit process |

Control readback:

- `Type=notify`, `NotifyAccess=all`, `WatchdogUSec=30s`;
- main PID `21794`, `NRestarts=0`;
- watchdog timestamp advanced from `2026-08-17 01:07:30 CST` through `01:08:30 CST`, spanning two full watchdog intervals;
- `/health` returned HTTP `200` with `{"status":"alive"}`;
- `/ready` returned HTTP `503`, `ready=false`, `hotArmed=false`;
- chain ID `4663`, head `38143268`, lag `0` for the final observation;
- HTTP, WSS and direct Sequencer probes were ready without sending a valid signed transaction;
- wallet readiness was `expected=10`, `fundingReady=10`, `nonceReady=10`, `signerReady=0`;
- Factory was `UNKNOWN`, identity was `L0`, entry and exit were disabled;
- SQLite WAL and execution lease were false because the Execution Plane was intentionally not started;
- unresolved attempts, open positions and verified exit routes were all `0`.

The exact `/ready` blockers were: missing HOT_ARMED Factory/Profile, missing profile revision, zero ready signers, no Execution Plane WAL/lease, entry disabled, reconciliation/exit disabled, and no verified executable exit route.

## Filesystem and secret boundary

The final readback verified:

- `/etc/clockin-sniper` is `0750 root:clockin-status`;
- `/etc/clockin-sniper/credentials` and `/etc/clockin-sniper/wallets` are `0700 root:root`;
- `/run/clockin-status` is `3770 root:clockin-status`;
- `control-status.json` is `0640 clockin-observer:clockin-status`;
- `/var/lib/clockin-control` is `0700 clockin-observer`;
- `/var/lib/clockin-sniper` is `0700 clockin`;
- the Control OS identity cannot read wallet key files;
- no private key, mnemonic, raw signed transaction, authenticated RPC URL, or credential value appeared in the inspected process metadata or journal;
- `/etc/clockin-sniper/PRODUCTION_ARM_APPROVED` was absent.

No key file contents were read or printed during deployment verification.

## Failure containment and rollback evidence

Deployment exposed three host-specific assumptions and one rollback interaction. Each failed attempt stopped before any execution service was started:

1. The first new Control start failed because the mount namespace expected `/run/clockin-status` before the unit began. The previous Control release was restored.
2. The next start failed with `EACCES`: mode `2750` did not grant status writers group write access. The runtime directory was changed to setgid, sticky, group-writable mode `3770`, then the previous release was restored again.
3. Ubuntu 24.04's installed `systemd-notify` does not implement the `--watchdog` option. The runtime was changed to send portable `WATCHDOG=1` notifications with the current PID; a rejected notification is contained so systemd remains the watchdog authority.
4. During rollback, the older Control unit could not traverse the newly tightened `0750` parent because it lacked the new supplementary group. The old parent mode was restored for rollback, then the final unit was installed with `clockin-status` and the hardened `0750` parent reapplied.
5. Invoking the versioned `bin/npm` directly still used its `/usr/bin/env node` shebang and selected the host's Node 18. The locked production dependency install was repeated by running the versioned Node `v24.19.0` against that installation's `npm-cli.js`; the final install audited 10 packages with zero vulnerabilities.

The stable deployment then remained active across multiple 30-second watchdog intervals with `NRestarts=0`. The previous immutable release and unit backup remain available for recoverable rollback. No database, nonce, position, signed payload, or chain state existed to migrate or discard.

## Stop boundary

The deployment is operationally prepared but economically and cryptographically unarmed. It must remain in this state until all of the following exist and are independently read back:

1. official final mainnet Launcher Factory and current buy/sell/finalize ABI;
2. exact-block runtime/proxy/profile identity and executable inner/outer exit routes;
3. fork/replay evidence for buy, receipt effect, sell, finalize and external swap;
4. an immutable production profile and an owner-approved authorization valid for no more than seven days;
5. a fresh signed `HOT_ARMED` readiness receipt;
6. only then, a root-owned arm marker and deliberate start of Reconciler, Exit and finally Executor.

Until then, `503` from `/ready`, zero signers, disabled execution units and an absent arm marker are the correct production result.
