# Production deployment runbook

## Status and stop boundary

This runbook describes a reproducible deployment, but it is not a deployment receipt. As of 2026-08-17, owner strategy bounds are frozen in `clockin-policy-v2` and all ten wallets were last verified funded with clean nonces. The keyless Control service is designed to run continuously on the selected production host using only Robinhood's official public HTTP RPC. Production activation remains blocked by the unpublished final mainnet Launcher Factory/ABI, missing immutable profile/current authorization, missing fork/replay proof for both exit routes, and missing active-region benchmark. Do not create `PRODUCTION_ARM_APPROVED` until `docs/receipts/production-readiness.md` reports `HOT_ARMED` with evidence for every gate.

Chainstack has a separate cost/capability boundary: do not create `PAID_RPC_APPROVED` merely because Control sees a name, website change, candidate CA, address-cluster transaction, or candidate contract. The owner must explicitly declare that a real-snipe preparation window is open. Paid approval does not authorize signing or broadcasting.

Never point the v2 systemd services at the legacy single-wallet `npm run live` entrypoint.

## Release artifact

1. Select a successful release workflow run and record the source commit, package version, Node version, artifact name, and published SHA-256 checksum.
2. Download the artifact and checksum through an authenticated administrative session.
3. Verify the checksum on the target host before extracting it to a versioned directory such as `/opt/clockin-sniper/releases/<commit-sha>`.
4. Run `npm ci --omit=dev` only when the release process deliberately ships source instead of a complete dependency bundle. Invoke that installation's `npm-cli.js` with the versioned Node binary; calling `bin/npm` can still select the host Node through `/usr/bin/env`. Never allow an unrecorded lockfile update.
5. Point `/opt/clockin-sniper/current` at the verified version only after the preflight below succeeds. Keep the previous version for rollback.

The deployment receipt must include command exit status and a readback of the installed artifact hash. A local build or template render is not cloud deployment evidence.

## OS identities and directories

- `clockin-observer`: keyless Control Sentinel user. It receives no credentials and has no paid RPC endpoint capability.
- `clockin`: executor, reconciler, and exit user. It owns `/var/lib/clockin-sniper` but cannot read repository-external source keys directly after credentials are mounted.
- `clockin-status`: non-login shared system group used only for traversing `/etc/clockin-sniper` and exchanging redacted status under `/run/clockin-status`; units receive it through `SupplementaryGroups`, and the runtime directory is setgid+sticky `3770` so each identity can atomically replace only its own status file.
- `/etc/clockin-sniper/control.env`: non-secret Control timing/local HTTP/status settings only; mode `0640` or stricter. It must contain no RPC URL, key, credential path, strategy authorization, or wallet secret.
- `/etc/clockin-sniper/strategy.env`: non-secret, versioned Execution strategy identifiers and paths only; mode `0640` or stricter. Control must not read it.
- `/etc/clockin-sniper/credentials`: RPC and vault credentials; root-owned mode `0700`, files `0400` or stricter.
- `/etc/clockin-sniper/wallets`: ten entry key files; root-owned mode `0700`, files `0400`.
- `/var/lib/clockin-sniper`: canonical SQLite database and encrypted signed-transaction vault; mode `0700`.

Create the two disabled-login users and the `clockin-status` system group before installing `deploy/systemd/clockin-sniper.tmpfiles.conf`, then apply `systemd-tmpfiles --create` **before** starting or restarting any unit. Verify `/run/clockin-status` is `3770 root:clockin-status`; `2750` is insufficient because both service identities must atomically create their own status file. The parent `/etc/clockin-sniper` is `root:clockin-status 0750`, but `credentials/` and `wallets/` remain `root:root 0700`; this lets Control traverse to its public manifest without granting secret access. Do not tighten the parent to `0750` until the candidate and rollback Control units both have a compatible supplementary group, or preserve the old parent mode while rolling back. Do not put a secret in a shell argument, environment value, unit file, process title, or journal.

## Render and verify units

Render each `.service.in` placeholder to an absolute path inside the checksum-verified release. The checked renderer rejects relative paths, whitespace/shell syntax, missing build entrypoints, and unresolved placeholders:

```bash
node deploy/render-systemd.mjs \
  --artifact-dir /opt/clockin-sniper/releases/<commit-sha> \
  --node /opt/clockin-sniper/runtime/node-v24.19.0-linux-x64/bin/node \
  --output-dir /tmp/clockin-rendered-units
```

Install the result in `/etc/systemd/system`, then run:

```bash
systemd-analyze verify /etc/systemd/system/clockin-*.service
systemctl daemon-reload
systemctl cat clockin-control clockin-executor clockin-reconciler clockin-exit
systemctl show clockin-control clockin-executor clockin-reconciler clockin-exit \
  -p User -p Group -p WorkingDirectory -p FragmentPath -p ExecStart -p ActiveState -p SubState
```

Save the redacted output in the private deployment receipt. Confirm that no credential value, raw signed transaction, or authenticated RPC URL appears. `clockin-control.service` must contain `EnvironmentFile=-/etc/clockin-sniper/control.env`, no `LoadCredential`, and no reference to `strategy.env`. The other three units must contain `ConditionPathExists=/etc/clockin-sniper/PAID_RPC_APPROVED`.

On Ubuntu 24.04, do not assume `systemd-notify --watchdog` exists. The portable heartbeat is `systemd-notify --pid=<main-pid> WATCHDOG=1`; the service must contain notification rejection and let systemd enforce the timeout. Confirm `WatchdogTimestamp` advances across at least two full watchdog intervals before declaring Control stable.

## Public monitoring startup

1. Install `deploy/control.env.example` as `/etc/clockin-sniper/control.env`, owned by `root:clockin-status`, mode `0640`. Review variable names and values; it must not contain any RPC URL or secret.
2. Ensure `/etc/clockin-sniper/PAID_RPC_APPROVED` and `/etc/clockin-sniper/PRODUCTION_ARM_APPROVED` are absent.
3. Disable `clockin-executor`, `clockin-reconciler`, and `clockin-exit`; then enable and start only `clockin-control`.
4. Verify `/health=200`, `/ready=503`, Dashboard HTTP 200, advancing watchdog/head, and `monitoringPolicy.mode=OFFICIAL_PUBLIC_HTTP_ONLY` with `paidRpcCapability=false`.
5. Verify the Control process has no systemd credentials directory, no RPC/Chainstack environment variable names, and no execution process. `/ready=503` is expected until the full Execution Plane is armed.

This mode is the default 24×7 state. It is not a real-snipe preparation window and must produce no Chainstack request.

## Explicit paid RPC window

Only after an explicit owner instruction to prepare for a real snipe, create a root-owned marker containing exactly:

```text
CLOCKIN_PAID_RPC_APPROVED_V1
```

Verify that the marker is a regular file, owned by UID 0, and not group/world writable. Then start Reconciler and Exit only if the immutable profile/authorization and recovery requirements are current. Starting Executor additionally requires the independent `PRODUCTION_ARM_APPROVED` marker and every `HOT_ARMED` gate below.

Never create either marker from Control, a website watcher, an alert handler, a name/CA match, or an automatic self-repair path. The application validates the paid marker before reading a paid RPC credential even when systemd's path condition passes.

## Fail-closed real-snipe startup sequence

1. Confirm `clockin-control` is healthy on the official public endpoint and record the current public snapshot.
2. Record the owner's explicit real-snipe preparation approval; create and validate `PAID_RPC_APPROVED`.
3. Require current chain ID 4663, genesis fingerprint, Factory code hash, final adapter capability revision, time sync, paid WSS/HTTP health, and SQLite migration success.
4. Verify all ten public wallet addresses, key correspondence, latest/pending nonce equality, principal balance, one-entry/one-approval/three-sell Gas reserves and 30% Gas margin; aggregate requirements must fit the frozen 60U all-in cap.
5. Verify the <=30-second dual-source price snapshot with <=2% deviation, the scope-bound <=7-day authorization, zero unresolved `UNKNOWN` attempts, single-writer lease ownership, and current quote/validity-envelope semantics.
6. Start `clockin-reconciler` and `clockin-exit`; wait for fresh local status files proving matching profile/authorization, WAL, signer and exit readiness. They must not create a second entry intent.
7. Only after the signed production-readiness receipt says `HOT_ARMED`, atomically create the root-owned `PRODUCTION_ARM_APPROVED` marker and start `clockin-executor`. Executor independently rechecks Reconciler/Exit before every lane signature.
8. Read back `/ready`, service state, active lease, database schema, artifact SHA, and capability revision. Save this as the deployment receipt.

Both markers are deployment interlocks, not proof by themselves. Removing them blocks a corresponding service at its next start; the application-level entry switch remains the immediate stop mechanism.

## Closing the paid window

1. Disable new entry.
2. Prove that all transaction attempts are terminal and both unresolved `UNKNOWN` count and open-position count are zero.
3. Stop Executor, Reconciler, and Exit. If either count is non-zero, keep the recovery/exit services and paid marker available or record an explicit manual-takeover incident instead.
4. Confirm the three paid service PIDs are zero.
5. Remove `PRODUCTION_ARM_APPROVED` and `PAID_RPC_APPROVED`.
6. Confirm Control remains active in `OFFICIAL_PUBLIC_HTTP_ONLY` mode and save a closure receipt.

## Logs and alerts

Application logs are structured and redacted before journald receives them. Never log private keys, mnemonics, raw signed transactions, vault plaintext, full authenticated URLs, or secret headers. Install `journald-clockin.conf` only after reviewing its host-wide impact. Verify retention and disk limits through `journalctl --disk-usage` and `systemctl show systemd-journald`.

Alert transport failure cannot block the execution hot path. Required critical events include Factory/code drift, CA conflict, canary failure, `UNKNOWN`, nonce conflict, funding loss, missing sell route, and automatic entry disablement.

## Rollback

1. Disable new entry; do not delete state or clear nonces.
2. Keep reconciliation and exit running if their adapter revisions remain compatible with open positions.
3. Confirm there is no unresolved signed/broadcast/`UNKNOWN` attempt before changing the active executor artifact.
4. Point `current` to the previous checksum-verified release, reload systemd, and restart only affected services.
5. Re-run the full readiness sequence and record old/new artifact hashes and canonical state counts.

Before step 4, confirm the previous unit can traverse the current `/etc/clockin-sniper` parent and write to `/run/clockin-status`. If the previous unit predates `clockin-status`, temporarily restore its recorded parent-mode boundary during rollback; never loosen `credentials/` or `wallets/`, and reapply the hardened parent only after the compatible unit is active.

If schema rollback is not explicitly supported by the migration ADR, restore neither an older binary nor an older database over current state. Use a forward fix.

## Acceptance evidence

A production deployment is complete only when a private receipt contains:

- host/region identity and time-sync state;
- source commit, package version, Node version, artifact SHA and checksum verification;
- rendered unit hash and `systemctl show` readback;
- directory/file modes without secret contents;
- `/health` and `/ready` responses;
- Factory/profile/adapter/config revisions and evidence IDs;
- 10/10 wallet and nonce readiness, without key material;
- active/observer lease state and failover drill result;
- redacted log/alert samples and rollback drill result.

Receipt absence means `NOT_DEPLOYED`, even if a process is locally runnable.
