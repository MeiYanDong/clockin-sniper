# Production deployment runbook

## Status and stop boundary

This runbook describes a reproducible deployment, but it is not a deployment receipt. As of 2026-08-17, owner strategy bounds are frozen in `clockin-policy-v2`, all ten wallets are funded with clean nonces, and the keyless Control service runs on the selected production host. Production activation remains blocked by the unpublished final mainnet Launcher Factory/ABI, missing immutable profile/current authorization, missing fork/replay proof for both exit routes, and missing active-region benchmark. Do not create `PRODUCTION_ARM_APPROVED` until `docs/receipts/production-readiness.md` reports `HOT_ARMED` with evidence for every gate.

Never point the v2 systemd services at the legacy single-wallet `npm run live` entrypoint.

## Release artifact

1. Select a successful release workflow run and record the source commit, package version, Node version, artifact name, and published SHA-256 checksum.
2. Download the artifact and checksum through an authenticated administrative session.
3. Verify the checksum on the target host before extracting it to a versioned directory such as `/opt/clockin-sniper/releases/<commit-sha>`.
4. Run `npm ci --omit=dev` only when the release process deliberately ships source instead of a complete dependency bundle. Never allow an unrecorded lockfile update.
5. Point `/opt/clockin-sniper/current` at the verified version only after the preflight below succeeds. Keep the previous version for rollback.

The deployment receipt must include command exit status and a readback of the installed artifact hash. A local build or template render is not cloud deployment evidence.

## OS identities and directories

- `clockin-observer`: keyless Control Sentinel user. It receives only RPC credentials.
- `clockin`: executor, reconciler, and exit user. It owns `/var/lib/clockin-sniper` but cannot read repository-external source keys directly after credentials are mounted.
- `/etc/clockin-sniper/strategy.env`: non-secret, versioned strategy identifiers and paths only; mode `0640` or stricter.
- `/etc/clockin-sniper/credentials`: RPC and vault credentials; root-owned mode `0700`, files `0400` or stricter.
- `/etc/clockin-sniper/wallets`: ten entry key files; root-owned mode `0700`, files `0400`.
- `/var/lib/clockin-sniper`: canonical SQLite database and encrypted signed-transaction vault; mode `0700`.

Install `deploy/systemd/clockin-sniper.tmpfiles.conf`, create the two users with disabled login shells, and apply `systemd-tmpfiles --create`. Do not put a secret in a shell argument, environment value, unit file, process title, or journal.

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

Save the redacted output in the private deployment receipt. Confirm that no credential value, raw signed transaction, or authenticated RPC URL appears.

## Fail-closed startup sequence

1. Start `clockin-control` without signer credentials.
2. Require current chain ID 4663, genesis fingerprint, Factory code hash, final adapter capability revision, time sync, WSS/HTTP health, and SQLite migration success.
3. Verify all ten public wallet addresses, key correspondence, latest/pending nonce equality, principal balance, one-entry/one-approval/three-sell Gas reserves and 30% Gas margin; aggregate requirements must fit the frozen 60U all-in cap.
4. Verify the <=30-second dual-source price snapshot with <=2% deviation, the scope-bound <=7-day authorization, zero unresolved `UNKNOWN` attempts, single-writer lease ownership, and current quote/validity-envelope semantics.
5. Start `clockin-reconciler` and `clockin-exit`; wait for fresh local status files proving matching profile/authorization, WAL, signer and exit readiness. They must not create a second entry intent.
6. Only after the signed production-readiness receipt says `HOT_ARMED`, atomically create the root-owned `PRODUCTION_ARM_APPROVED` marker and start `clockin-executor`. Executor independently rechecks Reconciler/Exit before every lane signature.
7. Read back `/ready`, service state, active lease, database schema, artifact SHA, and capability revision. Save this as the deployment receipt.

The marker is a deployment interlock, not proof by itself. Removing it blocks the executor at the next service start; the application-level entry switch remains the immediate stop mechanism.

## Logs and alerts

Application logs are structured and redacted before journald receives them. Never log private keys, mnemonics, raw signed transactions, vault plaintext, full authenticated URLs, or secret headers. Install `journald-clockin.conf` only after reviewing its host-wide impact. Verify retention and disk limits through `journalctl --disk-usage` and `systemctl show systemd-journald`.

Alert transport failure cannot block the execution hot path. Required critical events include Factory/code drift, CA conflict, canary failure, `UNKNOWN`, nonce conflict, funding loss, missing sell route, and automatic entry disablement.

## Rollback

1. Disable new entry; do not delete state or clear nonces.
2. Keep reconciliation and exit running if their adapter revisions remain compatible with open positions.
3. Confirm there is no unresolved signed/broadcast/`UNKNOWN` attempt before changing the active executor artifact.
4. Point `current` to the previous checksum-verified release, reload systemd, and restart only affected services.
5. Re-run the full readiness sequence and record old/new artifact hashes and canonical state counts.

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
