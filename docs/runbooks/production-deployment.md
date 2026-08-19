# Production deployment runbook

## Status and stop boundary

This runbook describes a reproducible deployment, but it is not a deployment receipt. The 2026-08-20 verified CLOCKIN primary path is a WETH quoted launch pad: exact pad plus approved creator `LaunchCreated` discovers CA/id, same-id `LaunchArmed` completes launch configuration, and the Executor then reads dynamic tax/launch/quote state before calling `buy(id, quoteIn, minTokensOut, ref)`. X and website monitoring are asynchronous confirmation/conflict inputs only; they are never hot-path triggers.

The old “final mainnet Launcher Factory/launch/buy ABI unpublished” blocker is historical and has been superseded for quoted entry. The current production blocker is deployment/readiness: quoted Executor code/tests and repository-external immutable profile plus seven-day authorization exist locally, but they have not been deployed. The host still runs only keyless Control; paid services are disabled/inactive, both markers are absent, and all ten wallets read `0 WETH / 0 allowance`. Native `0.0032 ETH` balances do not make the wallets spend-ready until bounded WETH deposit/approval transactions have canonical receipts.

Do not claim `HOT_ARMED` until a reviewed receipt proves the quoted artifact/profile/authorization are installed, the one-shot wallet preparation has canonical receipts, all ten wallets have current WETH/allowance/native-Gas/nonce readiness, and `clockin-executor.path` is the sole enabled paid-side trigger. Before a handoff, Executor and Reconciler must remain inactive; their inactivity is expected and proves that Chainstack is not being consumed early. Exit should be deployed for later position management but does not gate lanes 2–10; canonical canary effect, fresh Reconciler state and readiness of the still-pending wallet lanes do.

Chainstack has a separate cost/capability boundary: do not create `PAID_RPC_APPROVED` merely because Control sees a name, website change, candidate CA, address-cluster transaction, or candidate contract. The owner must explicitly declare that a real-snipe preparation window is open. Paid approval does not authorize signing or broadcasting. Once that window is explicitly open and both independent interlocks pass, `LaunchCreated`/`LaunchArmed` can drive automatic production buys without browser or X confirmation.

Never point the v2 systemd services at the legacy single-wallet `npm run live` entrypoint.

## Release artifact

1. Select a successful release workflow run and record the source commit, package version, Node version, artifact name, and published SHA-256 checksum.
2. Download the artifact and checksum through an authenticated administrative session.
3. Verify the checksum on the target host before extracting it. An npm archive expands under `package/`; the renderer and units require the payload at `<release-root>/clockin-sniper`, not at `<release-root>/package`.
4. Install production dependencies on every release. The published archive contains compiled `dist/` plus `npm-shrinkwrap.json`, but deliberately does **not** contain `node_modules`; without this step the production entrypoints fail while importing `ethers`. This is mandatory even though the archive already contains JavaScript.
5. Point `/opt/clockin-sniper/current` at the verified version only after the dependency/import and artifact preflight below succeeds. Keep the previous version for rollback.

Use a new staging directory and the checksum-pinned Node/npm installation. The selected npm archive basename, published SHA-256, checksum-file entry and extracted bytes are one binding: a checksum for archive A must never authorize extraction of archive B. The npm basename for the scoped package is `local-clockin-sniper-<version>.tgz`. On a first host, provision the two non-root identities in the next section before returning to this block, because both identities must import the staged artifact successfully. Replace the quoted placeholders before running this block; do not reuse an existing release directory:

```bash
set -euo pipefail
umask 022
RELEASE_COMMIT='<40-hex-source-commit>'
RELEASE_ARCHIVE_NAME='local-clockin-sniper-0.1.0.tgz'
RELEASE_EXPECTED_SHA256='<64-hex-published-sha256>'
RELEASE_INGRESS='/root/release-ingress'
RELEASE_ARCHIVE="${RELEASE_INGRESS}/${RELEASE_ARCHIVE_NAME}"
RELEASE_CHECKSUM="${RELEASE_INGRESS}/${RELEASE_ARCHIVE_NAME}.sha256"
RELEASE_ROOT="/opt/clockin-sniper/releases/${RELEASE_COMMIT}"
VERSIONED_NODE='/opt/clockin-sniper/runtime/node-v24.19.0-linux-x64/bin/node'
VERSIONED_NPM_CLI='/opt/clockin-sniper/runtime/node-v24.19.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js'

test "${RELEASE_COMMIT}" != '<40-hex-source-commit>'
test "${RELEASE_EXPECTED_SHA256}" != '<64-hex-published-sha256>'
printf '%s' "${RELEASE_EXPECTED_SHA256}" | grep -Eq '^[0-9a-f]{64}$'
test "$(basename -- "${RELEASE_ARCHIVE}")" = "${RELEASE_ARCHIVE_NAME}"
test -f "${RELEASE_ARCHIVE}"
test -f "${RELEASE_CHECKSUM}"
test "$(wc -l <"${RELEASE_CHECKSUM}")" -eq 1
CHECKSUM_SHA256="$(awk 'NF == 2 { print $1 }' "${RELEASE_CHECKSUM}")"
CHECKSUM_ARCHIVE_NAME="$(awk 'NF == 2 { print $2 }' "${RELEASE_CHECKSUM}")"
CHECKSUM_ARCHIVE_NAME="${CHECKSUM_ARCHIVE_NAME#\*}"
test "${CHECKSUM_SHA256}" = "${RELEASE_EXPECTED_SHA256}"
test "${CHECKSUM_ARCHIVE_NAME}" = "${RELEASE_ARCHIVE_NAME}"
ACTUAL_ARCHIVE_SHA256="$(sha256sum "${RELEASE_ARCHIVE}" | awk '{ print $1 }')"
test "${ACTUAL_ARCHIVE_SHA256}" = "${RELEASE_EXPECTED_SHA256}"
test ! -e "${RELEASE_ROOT}"
id -u clockin >/dev/null
id -u clockin-observer >/dev/null

RELEASE_STAGE="$(mktemp -d /opt/clockin-sniper/releases/.incoming.XXXXXX)"
chmod 0755 "${RELEASE_STAGE}"
install -d -m 0755 "${RELEASE_STAGE}/clockin-sniper"
tar --extract --gzip --file "${RELEASE_ARCHIVE}" \
  --strip-components=1 --directory "${RELEASE_STAGE}/clockin-sniper"

cd "${RELEASE_STAGE}/clockin-sniper"
test -f npm-shrinkwrap.json
test -f dist/control-service.js
test -f dist/stonk-safe-launch-executor-service.js
test -f dist/prepare-stonk-safe-launch-wallets.js
RELEASE_PACKAGE_DIR="${RELEASE_STAGE}/clockin-sniper" \
RELEASE_COMMIT="${RELEASE_COMMIT}" \
  "${VERSIONED_NODE}" --input-type=module -e '
    const { createHash } = await import("node:crypto");
    const { readFile } = await import("node:fs/promises");
    const root = process.env.RELEASE_PACKAGE_DIR;
    const metadata = JSON.parse(await readFile(`${root}/BUILD-METADATA.json`, "utf8"));
    const packageJson = JSON.parse(await readFile(`${root}/package.json`, "utf8"));
    const capability = await readFile(`${root}/capability-manifest.json`);
    const capabilityHash = createHash("sha256").update(capability).digest("hex");
    if (metadata.schemaVersion !== 2 || metadata.sourceCommit !== process.env.RELEASE_COMMIT ||
        metadata.sourceTreeState !== "CLEAN_EXCEPT_GENERATED_BUILD_METADATA" ||
        metadata.packageName !== packageJson.name || metadata.packageVersion !== packageJson.version ||
        metadata.capabilityManifestSha256 !== capabilityHash) {
      throw new Error("release metadata does not bind the selected clean commit/package/capability");
    }
    process.stdout.write(JSON.stringify({
      sourceCommit: metadata.sourceCommit,
      packageName: metadata.packageName,
      packageVersion: metadata.packageVersion,
      buildNodeVersion: metadata.nodeVersion,
      capabilityManifestRevision: metadata.capabilityManifestRevision,
      capabilityManifestSha256: metadata.capabilityManifestSha256,
    }) + "\\n");
  '
"${VERSIONED_NODE}" "${VERSIONED_NPM_CLI}" ci --omit=dev --ignore-scripts
"${VERSIONED_NODE}" "${VERSIONED_NPM_CLI}" ls --omit=dev
chmod 0755 "${RELEASE_STAGE}" "${RELEASE_STAGE}/clockin-sniper"
namei -l "${RELEASE_STAGE}/clockin-sniper/dist/control-service.js"
namei -l "${RELEASE_STAGE}/clockin-sniper/dist/stonk-safe-launch-executor-service.js"
runuser -u clockin-observer -- env RELEASE_PACKAGE_DIR="${RELEASE_STAGE}/clockin-sniper" \
  "${VERSIONED_NODE}" --input-type=module -e \
  'await import(`file://${process.env.RELEASE_PACKAGE_DIR}/dist/control-service.js`)'
runuser -u clockin -- env RELEASE_PACKAGE_DIR="${RELEASE_STAGE}/clockin-sniper" \
  "${VERSIONED_NODE}" --input-type=module -e \
  'await import("ethers"); await import(`file://${process.env.RELEASE_PACKAGE_DIR}/dist/stonk-safe-launch-executor-service.js`)'

mv -- "${RELEASE_STAGE}" "${RELEASE_ROOT}"
chmod 0755 "${RELEASE_ROOT}" "${RELEASE_ROOT}/clockin-sniper"
runuser -u clockin-observer -- test -r "${RELEASE_ROOT}/clockin-sniper/dist/control-service.js"
runuser -u clockin -- test -r "${RELEASE_ROOT}/clockin-sniper/dist/stonk-safe-launch-executor-service.js"
sha256sum "${RELEASE_ARCHIVE}" \
  "${RELEASE_ROOT}/clockin-sniper/BUILD-METADATA.json" \
  "${RELEASE_ROOT}/clockin-sniper/capability-manifest.json"
```

If the exact basename/SHA binding, `npm ci`, `npm ls`, either non-root import, traversal/readback, or any required-file check fails, quarantine that staging directory and do not render or activate it. Invoke `npm-cli.js` with the versioned Node binary as shown; calling `bin/npm` can still select the host Node through `/usr/bin/env`. Never allow an unrecorded lockfile or shrinkwrap update.

Subsequent command blocks assume the same root Bash session and its recorded `RELEASE_ROOT`, `VERSIONED_NODE`, and `VERSIONED_NPM_CLI` values. After any reconnect, restore those three values from the deployment receipt and re-run their `test` readbacks; never infer them from an unverified `current` symlink.

The deployment receipt must include command exit status and a readback of the installed artifact hash. A local build or template render is not cloud deployment evidence.

## OS identities and directories

- `clockin-observer`: keyless Control Sentinel user. It receives no credentials and has no paid RPC endpoint capability.
- `clockin`: executor, reconciler, and exit user. It owns `/var/lib/clockin-sniper` but cannot read repository-external source keys directly after credentials are mounted.
- `clockin-status`: non-login shared system group used only for traversing `/etc/clockin-sniper` and reading redacted cross-plane status. `/run/clockin-status` is non-writable `root:clockin-status 0750`; only `clockin-observer` can write the setgid `control/` tier and only `clockin` can write the setgid `paid/` tier. A predictable filename in a shared writable directory is not an isolation boundary.
- `/etc/clockin-sniper/control.env`: non-secret Control timing/local HTTP/status settings only; mode `0640` or stricter. It must contain no RPC URL, key, credential path, strategy authorization, or wallet secret.
- `/etc/clockin-sniper/strategy.env`: non-secret, versioned Execution strategy identifiers and paths only; mode `0640` or stricter. Control must not read it.
- `/etc/clockin-sniper/credentials`: RPC and vault credentials; root-owned mode `0700`, files `0400` or stricter.
- `/etc/clockin-sniper/wallets`: ten entry key files; root-owned mode `0700`, files `0400`.
- `/var/lib/clockin-sniper`: canonical SQLite database and encrypted signed-transaction vault; mode `0700`.

Create the two disabled-login users and the `clockin-status` system group before installing `deploy/systemd/clockin-sniper.tmpfiles.conf`, then apply `systemd-tmpfiles --create` **before** starting or restarting any unit. Verify `/run/clockin-status` is `0750 root:clockin-status`, `/run/clockin-status/control` is `2750 clockin-observer:clockin-status`, and `/run/clockin-status/paid` is `2750 clockin:clockin-status`. Neither service identity may write the other tier or the common parent. The parent `/etc/clockin-sniper` is `root:clockin-status 0750`, but `credentials/` and `wallets/` remain `root:root 0700`; this lets Control traverse to its public manifest without granting secret access. Do not tighten the parent to `0750` until the candidate and rollback Control units both have a compatible supplementary group, or preserve the old parent mode while rolling back. Do not put a secret in a shell argument, environment value, unit file, process title, or journal.

Provision identities and directories idempotently as root:

```bash
getent group clockin-status >/dev/null || groupadd --system clockin-status
getent group clockin >/dev/null || groupadd --system clockin
getent group clockin-observer >/dev/null || groupadd --system clockin-observer

id -u clockin >/dev/null 2>&1 || useradd --system --gid clockin \
  --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin clockin
id -u clockin-observer >/dev/null 2>&1 || useradd --system --gid clockin-observer \
  --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin clockin-observer
usermod --append --groups clockin-status clockin
usermod --append --groups clockin-status clockin-observer

install -o root -g root -m 0644 \
  "${RELEASE_ROOT}/clockin-sniper/deploy/systemd/clockin-sniper.tmpfiles.conf" \
  /etc/tmpfiles.d/clockin-sniper.conf
systemd-tmpfiles --create /etc/tmpfiles.d/clockin-sniper.conf

id clockin
id clockin-observer
stat -c '%U:%G %a %n' \
  /etc/clockin-sniper \
  /etc/clockin-sniper/public \
  /etc/clockin-sniper/credentials \
  /etc/clockin-sniper/wallets \
  /var/lib/clockin-sniper \
  /var/lib/clockin-handoff \
  /var/lib/clockin-handoff/outbox \
  /run/clockin-status \
  /run/clockin-status/control \
  /run/clockin-status/paid
```

Expected modes are defined by the installed tmpfiles file: in particular, `/etc/clockin-sniper/public` is `root:root 0755`, the two secret directories are `root:root 0700`, and the three status paths have the exact owners/modes above. Any different owner, group, or mode blocks startup. Runtime status writes use random `O_EXCL` temporary names, reject symlinks and non-regular files, reject group/world-writable status files, then atomically rename inside the service-owned tier.

## Stage configuration and credentials

All input material must arrive through a root-only path outside the Git checkout and release tree. Do not paste any RPC endpoint, vault key, or wallet key into a terminal command, environment variable, unit, journal, or deployment receipt. The following commands copy files without displaying their contents; replace only the two source-directory placeholders:

```bash
set -euo pipefail
PUBLIC_CONFIG_SOURCE='/root/clockin-ingress/reviewed-config'
SECRET_SOURCE='/root/clockin-ingress/root-only-secrets'
test -d "${PUBLIC_CONFIG_SOURCE}"
test -d "${SECRET_SOURCE}"

install -o root -g clockin-status -m 0640 \
  "${RELEASE_ROOT}/clockin-sniper/deploy/control.env.example" \
  /etc/clockin-sniper/control.env
install -o root -g clockin-status -m 0640 \
  "${PUBLIC_CONFIG_SOURCE}/strategy.env" \
  /etc/clockin-sniper/strategy.env
if grep -Eiq '^[[:space:]]*[^#]*((https|wss)://|chainstack|private.?key|mnemonic|seed.?phrase)' \
  /etc/clockin-sniper/control.env /etc/clockin-sniper/strategy.env; then
  printf '%s\n' 'non-secret environment boundary check failed' >&2
  exit 1
fi

install -o root -g root -m 0644 \
  "${PUBLIC_CONFIG_SOURCE}/entry-manifest.json" \
  /etc/clockin-sniper/public/entry-manifest.json
install -o root -g root -m 0400 \
  "${PUBLIC_CONFIG_SOURCE}/entry-manifest.json" \
  /etc/clockin-sniper/credentials/entry-manifest.json
install -o root -g root -m 0400 \
  "${PUBLIC_CONFIG_SOURCE}/factory-profile.json" \
  /etc/clockin-sniper/credentials/factory-profile.json
install -o root -g root -m 0400 \
  "${PUBLIC_CONFIG_SOURCE}/production-authorization.json" \
  /etc/clockin-sniper/credentials/production-authorization.json

for credential_name in rpc_http rpc_wss sequencer_http vault_key; do
  install -o root -g root -m 0400 \
    "${SECRET_SOURCE}/${credential_name}" \
    "/etc/clockin-sniper/credentials/${credential_name}"
done
for lane in {01..10}; do
  install -o root -g root -m 0400 \
    "${SECRET_SOURCE}/entry-${lane}.key" \
    "/etc/clockin-sniper/wallets/entry-${lane}.key"
done
```

Perform a fresh structural and scope-binding readback without reading any wallet/RPC/vault value. The application parser below validates ten unique chain-4663 entry addresses, exact quoted profile binding, current authorization validity, and the seven-day maximum TTL:

```bash
set -euo pipefail
test "$(find /etc/clockin-sniper/wallets -maxdepth 1 -type f \
  -name 'entry-??.key' -printf . | wc -c)" -eq 10
for lane in {01..10}; do
  test "$(stat -c '%U:%G:%a' "/etc/clockin-sniper/wallets/entry-${lane}.key")" = 'root:root:400'
done
for credential_name in rpc_http rpc_wss sequencer_http vault_key \
  entry-manifest.json factory-profile.json production-authorization.json; do
  test -s "/etc/clockin-sniper/credentials/${credential_name}"
  test "$(stat -c '%U:%G:%a' "/etc/clockin-sniper/credentials/${credential_name}")" = 'root:root:400'
done
cmp --silent \
  /etc/clockin-sniper/public/entry-manifest.json \
  /etc/clockin-sniper/credentials/entry-manifest.json

PREFLIGHT_CREDENTIALS="$(mktemp -d /run/clockin-credential-preflight.XXXXXX)"
trap 'rm -rf -- "${PREFLIGHT_CREDENTIALS}"' EXIT
ln -s /etc/clockin-sniper/credentials/entry-manifest.json \
  "${PREFLIGHT_CREDENTIALS}/wallet_manifest"
ln -s /etc/clockin-sniper/credentials/factory-profile.json \
  "${PREFLIGHT_CREDENTIALS}/factory_profile"
ln -s /etc/clockin-sniper/credentials/production-authorization.json \
  "${PREFLIGHT_CREDENTIALS}/authorization"
CREDENTIALS_DIRECTORY="${PREFLIGHT_CREDENTIALS}" \
RELEASE_RUNTIME_URL="file://${RELEASE_ROOT}/clockin-sniper/dist/runtime/credentials.js" \
  "${VERSIONED_NODE}" --input-type=module -e '
    const runtime = await import(process.env.RELEASE_RUNTIME_URL);
    const manifest = await runtime.loadProductionWalletManifest();
    const { profile, authorization } =
      await runtime.loadStonkSafeLaunchProfileAndAuthorization(manifest);
    process.stdout.write(JSON.stringify({
      walletCount: manifest.entries.length,
      profileId: profile.profileId,
      profileHash: profile.profileHash,
      authorizationId: authorization.authorizationId,
      expiresAt: authorization.expiresAt,
    }) + "\\n");
  '
rm -rf -- "${PREFLIGHT_CREDENTIALS}"
trap - EXIT

stat -c '%U:%G %a %n' \
  /etc/clockin-sniper/control.env \
  /etc/clockin-sniper/strategy.env \
  /etc/clockin-sniper/public/entry-manifest.json \
  /etc/clockin-sniper/credentials/* \
  /etc/clockin-sniper/wallets/*
sha256sum \
  /etc/clockin-sniper/public/entry-manifest.json \
  /etc/clockin-sniper/credentials/factory-profile.json \
  /etc/clockin-sniper/credentials/production-authorization.json
```

The final `stat` is a filename/owner/mode readback only. Never hash, print, `cat`, or upload the RPC, vault, or wallet-key files. Record only the three non-secret configuration hashes and the parser's identifiers/expiry in the private deployment receipt. Any parser, freshness, copy-equality, count, owner, or mode failure blocks markers and service activation.

## Render and verify units

Render each `.service.in` placeholder to an absolute path inside the checksum-verified release. The checked renderer rejects relative paths, whitespace/shell syntax, missing build entrypoints, and unresolved placeholders:

```bash
set -euo pipefail
test -d "${RELEASE_ROOT}/clockin-sniper"
test -x "${VERSIONED_NODE}"
RENDERED_UNITS="$(mktemp -d /run/clockin-rendered-units.XXXXXX)"
"${VERSIONED_NODE}" "${RELEASE_ROOT}/clockin-sniper/deploy/render-systemd.mjs" \
  --artifact-dir "${RELEASE_ROOT}" \
  --node "${VERSIONED_NODE}" \
  --output-dir "${RENDERED_UNITS}"
```

Install the result in `/etc/systemd/system`, then run:

```bash
for unit_name in \
  clockin-control.service \
  clockin-wallet-preparer.service \
  clockin-executor.path \
  clockin-executor.service \
  clockin-reconciler.service \
  clockin-exit.service; do
  install -o root -g root -m 0644 \
    "${RENDERED_UNITS}/${unit_name}" \
    "/etc/systemd/system/${unit_name}"
done
systemd-analyze verify \
  /etc/systemd/system/clockin-*.service \
  /etc/systemd/system/clockin-executor.path
systemctl daemon-reload
systemctl cat clockin-control clockin-wallet-preparer clockin-executor.path \
  clockin-executor clockin-reconciler clockin-exit
systemctl show clockin-control clockin-wallet-preparer clockin-executor.path \
  clockin-executor clockin-reconciler clockin-exit \
  -p User -p Group -p WorkingDirectory -p FragmentPath -p ExecStart \
  -p UnitFileState -p ActiveState -p SubState -p Before -p Conflicts

NEXT_LINK='/opt/clockin-sniper/current.next'
test ! -e "${NEXT_LINK}"
ln -s "${RELEASE_ROOT}" "${NEXT_LINK}"
mv -T "${NEXT_LINK}" /opt/clockin-sniper/current

# enable --now does not replace an already-running MainPID after a unit update.
systemctl restart clockin-control.service
systemctl is-active --quiet clockin-control.service
CONTROL_MAIN_PID="$(systemctl show clockin-control.service -p MainPID --value)"
test "${CONTROL_MAIN_PID}" -gt 0
CONTROL_CMDLINE="$(tr '\0' ' ' <"/proc/${CONTROL_MAIN_PID}/cmdline")"
case "${CONTROL_CMDLINE}" in
  *"${RELEASE_ROOT}/clockin-sniper/dist/control-service.js"*) ;;
  *) printf '%s\n' 'Control MainPID is not running the selected release' >&2; exit 1 ;;
esac
systemctl show clockin-control.service \
  -p MainPID -p ExecMainStartTimestampMonotonic -p WorkingDirectory -p ExecStart
```

Save the redacted output in the private deployment receipt. Confirm that no credential value, raw signed transaction, or authenticated RPC URL appears. Installing a unit plus `daemon-reload` is not activation evidence; the explicit restart and `/proc/<MainPID>/cmdline` binding above are required. `clockin-control.service` must contain `EnvironmentFile=-/etc/clockin-sniper/control.env`, no `LoadCredential`, and no reference to `strategy.env`. Every paid service must contain `ConditionPathExists=/etc/clockin-sniper/PAID_RPC_APPROVED`; every signer-capable service must also require the production-arm marker. The preparer must read back both `Before=clockin-executor.path clockin-executor.service` and `Conflicts=clockin-executor.path clockin-executor.service`; otherwise a handoff can interrupt preparation and deployment is blocked.

On Ubuntu 24.04, do not assume `systemd-notify --watchdog` exists. The portable heartbeat is `systemd-notify --pid=<main-pid> WATCHDOG=1`; the service must contain notification rejection and let systemd enforce the timeout. Confirm `WatchdogTimestamp` advances across at least two full watchdog intervals before declaring Control stable.

## Public monitoring startup

1. Confirm the staged `/etc/clockin-sniper/control.env` is owned by `root:clockin-status`, mode `0640`, and contains no RPC URL or secret.
2. Ensure `/etc/clockin-sniper/PAID_RPC_APPROVED` and `/etc/clockin-sniper/PRODUCTION_ARM_APPROVED` are absent. If either exists, use the paid-window closure procedure instead of silently removing it.
3. Run `systemctl disable --now clockin-executor.path`, stop every static paid service, then enable and start only `clockin-control`.
4. Verify `/health=200`, `/ready=503`, Dashboard HTTP 200, advancing watchdog/head, and `monitoringPolicy.mode=OFFICIAL_PUBLIC_HTTP_ONLY` with `paidRpcCapability=false`, `minimumRequestIntervalMs=500`, and bounded `throttledRetries`.
5. Verify the Control process has no systemd credentials directory, no RPC/Chainstack environment variable names, and no execution process. `/ready=503` is expected until the full Execution Plane is armed.

Use this exact cold-start state transition and readback:

```bash
set -euo pipefail
test ! -e /etc/clockin-sniper/PAID_RPC_APPROVED
test ! -e /etc/clockin-sniper/PRODUCTION_ARM_APPROVED
systemctl disable --now clockin-executor.path
systemctl stop \
  clockin-wallet-preparer.service \
  clockin-executor.service \
  clockin-reconciler.service \
  clockin-exit.service
systemctl enable --now clockin-control.service

systemctl show \
  clockin-control.service \
  clockin-executor.path \
  clockin-wallet-preparer.service \
  clockin-executor.service \
  clockin-reconciler.service \
  clockin-exit.service \
  -p Id -p UnitFileState -p ActiveState -p SubState -p MainPID
```

Expected cold state is: Control `enabled/active`; executor path `disabled/inactive`; preparer, Executor, Reconciler, and Exit each `static/inactive`. `static` is the correct unit-file state for these on-demand services, not a failed attempt to disable them. No static paid service may have a nonzero `MainPID`.

This mode is the default 24×7 state. It is not a real-snipe preparation window and must produce no Chainstack request. The startup/hourly 31-call wallet-readiness pass must be paced rather than concurrent; an unresolved HTTP 429 leaves funding/nonce readiness missing and must not be reported as a successful readiness check.

## Explicit paid RPC window

Only after an explicit owner instruction to prepare for a real snipe, create the two independent root-owned markers. Their exact values are:

```text
CLOCKIN_PAID_RPC_APPROVED_V1
CLOCKIN_PRODUCTION_ARM_APPROVED_V1
```

Create them atomically without putting either value in a unit or environment file:

```bash
set -euo pipefail
umask 077
test ! -e /etc/clockin-sniper/PAID_RPC_APPROVED
test ! -e /etc/clockin-sniper/PRODUCTION_ARM_APPROVED

PAID_MARKER_TMP="$(mktemp /etc/clockin-sniper/.PAID_RPC_APPROVED.XXXXXX)"
printf '%s\n' 'CLOCKIN_PAID_RPC_APPROVED_V1' >"${PAID_MARKER_TMP}"
chown root:root "${PAID_MARKER_TMP}"
chmod 0400 "${PAID_MARKER_TMP}"
mv -T "${PAID_MARKER_TMP}" /etc/clockin-sniper/PAID_RPC_APPROVED

ARM_MARKER_TMP="$(mktemp /etc/clockin-sniper/.PRODUCTION_ARM_APPROVED.XXXXXX)"
printf '%s\n' 'CLOCKIN_PRODUCTION_ARM_APPROVED_V1' >"${ARM_MARKER_TMP}"
chown root:root "${ARM_MARKER_TMP}"
chmod 0400 "${ARM_MARKER_TMP}"
mv -T "${ARM_MARKER_TMP}" /etc/clockin-sniper/PRODUCTION_ARM_APPROVED

test -f /etc/clockin-sniper/PAID_RPC_APPROVED
test -f /etc/clockin-sniper/PRODUCTION_ARM_APPROVED
test "$(stat -c '%u:%g:%a' /etc/clockin-sniper/PAID_RPC_APPROVED)" = '0:0:400'
test "$(stat -c '%u:%g:%a' /etc/clockin-sniper/PRODUCTION_ARM_APPROVED)" = '0:0:400'
cmp --silent /etc/clockin-sniper/PAID_RPC_APPROVED \
  <(printf '%s\n' 'CLOCKIN_PAID_RPC_APPROVED_V1')
cmp --silent /etc/clockin-sniper/PRODUCTION_ARM_APPROVED \
  <(printf '%s\n' 'CLOCKIN_PRODUCTION_ARM_APPROVED_V1')
```

Do not start Reconciler or Executor here: paid transport must remain dormant until the public handoff. Wallet preparation requires both markers because wrapping and approving are real signed production transactions. Exit readiness is operationally desirable but is not a signing prerequisite for lanes 2–10.

Never create either marker from Control, a website watcher, an alert handler, a name/CA match, or an automatic self-repair path. The application validates the paid marker before reading a paid RPC credential even when systemd's path condition passes.

## Fail-closed real-snipe startup sequence

1. Confirm `clockin-control` is healthy on the official public endpoint and record the current public snapshot. The redacted Control status must show a known confirmed head, cursor equal to that confirmed head, `PUBLIC_HANDOFF_LAG_BLOCKS=0`, and `PUBLIC_HANDOFF_CAUGHT_UP=YES`; do not enable the path while historical catch-up is incomplete.
2. Record the owner's explicit real-snipe preparation approval; create and validate both `PAID_RPC_APPROVED` and `PRODUCTION_ARM_APPROVED`. These markers authorize the bounded one-shot preparation, but do not make a wallet ready by themselves.
3. Require current chain ID 4663, genesis fingerprint, exact quoted-pad and WETH runtime identities, approved creator, frozen Created/Armed/getter/buy bindings, time sync, paid WSS/HTTP health, and SQLite migration success.
4. Verify all ten public wallet/key correspondences. Before any preparation transaction, calculate all ten complete plans from a fresh ETH/USD and Gas snapshot and prove they remain inside the 60U all-in cap. Do not broadcast a partial plan.
5. Verify the <=30-second dual-source price snapshot with <=2% deviation, the scope-bound <=7-day authorization containing `BOUNDED_CANARY_POLICY_HASH`, zero unresolved `UNKNOWN` attempts, single-writer lease ownership, and current buy quote/validity semantics.
6. Run `systemctl disable --now clockin-executor.path` before the one-shot preparer. Its unit also conflicts with both the path and Executor as a second line of defense, so a handoff cannot interrupt wallet preparation. Require the durable recovery journal to be fully terminal, then save canonical deposit/approval receipts and the 10/10 readiness readback.
7. Keep `clockin-executor`, `clockin-reconciler`, and `clockin-exit` `static/inactive`. Enable and start only `clockin-executor.path`, whose sole watch target is `active.signal`—never `current.json` or a tombstone. Unconditionally restart healthy keyless Control after the path becomes active. Control replays `active.signal` only when its durable `current.json` readback is canonically `ACTIVE`; an `INVALIDATED` tombstone never touches the signal. Verify that an active pointer changes the signal and starts Executor, while a tombstone does neither. Do not manually start Executor or Reconciler. On ordinary boot, the path unit is ordered before Control so the same replay cannot be missed.
8. The public Control plane accepts only exact-pad, exact-approved-creator, `externalToken=false` `LaunchCreated` logs whose token returns exact `Clock In`/`CLOCKIN` metadata at the event block. It writes a non-sensitive handoff. That file starts the paid Executor, which in turn starts its required Reconciler. Both processes revalidate the two markers at runtime.
9. The paid Executor binds the handoff to a canonical receipt/log, subscribes to the exact quoted pad before backfill, and waits for same-id `LaunchArmed`. Do not wait for X or website confirmation. During the launch's `9999 bps` anti-bot buffer do not sign; the verified current default is 300 seconds, then `3300 bps` decaying `100 bps` per minute, but every value must be read dynamically from the current launch.
10. At each fee lane, Executor must re-read launch/window/deadline/current tax and an exact-principal `quoteBuy`, derive positive minOut, and then sign/broadcast the nonpayable WETH buy. Lane 1 remains at most 5U and at most one business intent. The final target is the lowest tax reachable strictly before `deadline`; under the current default it is 1%, because 0% occurs only at the rejected deadline.
11. Lanes 2–10 remain blocked until the canonical canary EffectRecord, fresh Reconciler/WAL with zero unresolved attempts, matching profile/authorization, readiness of the still-pending wallets, and fresh positive same-principal quotes are current. A wallet already used by a canonical completed lane is restored from its EffectRecord and is not incorrectly required to still hold the spent WETH. Exit is not one of these entry gates.
12. Executor exits at authorization expiry, bounded Created-without-Armed timeout, launch deadline, or runtime marker revocation; Reconciler also rechecks both markers before any same-raw replay and stops when no longer required. Confirm that paid connections do not remain resident outside the transaction/recovery window.
13. Read back `/ready`, both readiness tiers, service/path state, active lease, database schema, artifact SHA, and capability revision. Save this as the deployment receipt; before handoff explicitly prove path active plus Executor/Reconciler inactive, and after handoff prove quoted Executor activation from its own status rather than inferring it from Control health.

The unit transition for steps 6–7 is:

```bash
set -euo pipefail
systemctl disable --now clockin-executor.path
systemctl stop clockin-executor.service clockin-reconciler.service clockin-exit.service
systemctl show clockin-wallet-preparer.service \
  -p UnitFileState -p Before -p Conflicts -p ActiveState

systemctl start clockin-wallet-preparer.service
test "$(systemctl show clockin-wallet-preparer.service -p Result --value)" = 'success'
test "$(systemctl show clockin-wallet-preparer.service -p ExecMainStatus --value)" = '0'
systemctl show clockin-wallet-preparer.service \
  -p UnitFileState -p ActiveState -p SubState -p Result -p ExecMainStatus

# Stop here until canonical preparation receipts and fresh 10/10 readiness are saved.
"${VERSIONED_NODE}" --input-type=module -e '
  const { readFile } = await import("node:fs/promises");
  const value = JSON.parse(await readFile(
    "/run/clockin-status/control/control-status.json", "utf8"));
  const details = new Set(value.details ?? []);
  const cursor = [...details].find((item) => item.startsWith("PUBLIC_HANDOFF_CURSOR="));
  const head = [...details].find((item) => item.startsWith("PUBLIC_HANDOFF_CONFIRMED_HEAD="));
  if (!details.has("PUBLIC_HANDOFF_LAG_BLOCKS=0") ||
      !details.has("PUBLIC_HANDOFF_CAUGHT_UP=YES") || !cursor || !head ||
      cursor.slice(cursor.indexOf("=") + 1) !== head.slice(head.indexOf("=") + 1)) {
    throw new Error("public handoff cursor has not caught up to confirmed head");
  }
'
EXECUTOR_START_BEFORE="$(systemctl show clockin-executor.service \
  -p ExecMainStartTimestampMonotonic --value)"
SIGNAL_MTIME_BEFORE="$(stat -c '%Y' \
  /var/lib/clockin-handoff/outbox/active.signal 2>/dev/null || printf '%s' 'MISSING')"
systemctl enable --now clockin-executor.path
systemctl restart clockin-control.service
systemctl is-active --quiet clockin-control.service

CURRENT_POINTER_KIND="EMPTY"
if test -f /var/lib/clockin-handoff/outbox/current.json; then
  CURRENT_POINTER_KIND="$("${VERSIONED_NODE}" --input-type=module -e '
    const { readFile } = await import("node:fs/promises");
    const value = JSON.parse(await readFile(
      "/var/lib/clockin-handoff/outbox/current.json", "utf8"));
    process.stdout.write(String(value.kind ?? "INVALID"));
  ')"
fi
if test "${CURRENT_POINTER_KIND}" = 'CURRENT_PUBLIC_LAUNCH_HANDOFF'; then
  test -f /var/lib/clockin-handoff/outbox/active.signal
  for attempt in {1..30}; do
    EXECUTOR_START_AFTER="$(systemctl show clockin-executor.service \
      -p ExecMainStartTimestampMonotonic --value)"
    test -n "${EXECUTOR_START_AFTER}" && \
      test "${EXECUTOR_START_AFTER}" != "${EXECUTOR_START_BEFORE}" && break
    sleep 1
  done
  test -n "${EXECUTOR_START_AFTER}"
  test "${EXECUTOR_START_AFTER}" != "${EXECUTOR_START_BEFORE}"
elif test "${CURRENT_POINTER_KIND}" = 'INVALIDATED_PUBLIC_LAUNCH_HANDOFF'; then
  SIGNAL_MTIME_AFTER="$(stat -c '%Y' \
    /var/lib/clockin-handoff/outbox/active.signal 2>/dev/null || printf '%s' 'MISSING')"
  test "${SIGNAL_MTIME_AFTER}" = "${SIGNAL_MTIME_BEFORE}"
elif test "${CURRENT_POINTER_KIND}" != 'EMPTY'; then
  printf '%s\n' 'unrecognized public handoff pointer; activation blocked' >&2
  exit 1
fi
systemctl show \
  clockin-control.service \
  clockin-executor.path \
  clockin-wallet-preparer.service \
  clockin-executor.service \
  clockin-reconciler.service \
  clockin-exit.service \
  -p Id -p UnitFileState -p ActiveState -p SubState -p MainPID
```

Before a handoff and when no active pointer exists, expected state is Control `enabled/active`, executor path `enabled/active (waiting)`, and all four service units `static/inactive` with zero PIDs. The successful oneshot preparer normally returns to `inactive/dead`; its `Result=success` and `ExecMainStatus=0`, together with canonical chain receipts and the application readiness report, are the evidence. The Control restart is mandatory even when no pointer is present. If a valid active `current.json` already exists, the changed `active.signal` and changed Executor start timestamp are the receipt; if the pointer is an invalidation tombstone, unchanged signal mtime is the receipt. File existence alone is not launch validity.

Both markers are deployment interlocks, not proof by themselves. Removing either is an immediate runtime stop signal: Executor and Reconciler revalidate the markers during operation and immediately before signing/rebroadcasting. The application-level entry switch remains an additional stop mechanism.

## Closing the paid window

1. Disable new entry.
2. Prove that all transaction attempts are terminal and both unresolved `UNKNOWN` count and open-position count are zero.
3. Run `systemctl disable --now clockin-executor.path`, then stop preparer, Executor, Reconciler, and Exit. If either count is non-zero, keep the required recovery/exit services and paid marker available or record an explicit manual-takeover incident instead.
4. Confirm the path is inactive and all four static paid-service PIDs are zero.
5. Remove `PRODUCTION_ARM_APPROVED` and `PAID_RPC_APPROVED`.
6. Confirm Control remains active in `OFFICIAL_PUBLIC_HTTP_ONLY` mode and save a closure receipt.

Do not run this block until step 2 is proven:

```bash
systemctl disable --now clockin-executor.path
systemctl stop \
  clockin-wallet-preparer.service \
  clockin-executor.service \
  clockin-reconciler.service \
  clockin-exit.service
systemctl show clockin-executor.path clockin-wallet-preparer.service \
  clockin-executor.service clockin-reconciler.service clockin-exit.service \
  -p Id -p UnitFileState -p ActiveState -p SubState -p MainPID
rm -- /etc/clockin-sniper/PRODUCTION_ARM_APPROVED
rm -- /etc/clockin-sniper/PAID_RPC_APPROVED
test ! -e /etc/clockin-sniper/PRODUCTION_ARM_APPROVED
test ! -e /etc/clockin-sniper/PAID_RPC_APPROVED
systemctl is-active clockin-control.service
```

## Logs and alerts

Application logs are structured and redacted before journald receives them. Never log private keys, mnemonics, raw signed transactions, vault plaintext, full authenticated URLs, or secret headers. Install `journald-clockin.conf` only after reviewing its host-wide impact. Verify retention and disk limits through `journalctl --disk-usage` and `systemctl show systemd-journald`.

Alert transport failure cannot block the execution hot path. Required critical events include Factory/code drift, CA conflict, canary failure, `UNKNOWN`, nonce conflict, funding loss, missing sell route, and automatic entry disablement.

## Rollback

1. Disable new entry; do not delete state or clear nonces.
2. Keep reconciliation and exit running if their adapter revisions remain compatible with open positions.
3. Confirm there is no unresolved signed/broadcast/`UNKNOWN` attempt before changing the active executor artifact.
4. Re-run the dependency/import/metadata preflight for the previous checksum-verified release, render and verify all units with that exact previous release root, install those rendered units, and run `systemctl daemon-reload`. Only then atomically point `current` to the same previous root and restart the affected services.
5. Re-run the full readiness sequence and record old/new artifact hashes and canonical state counts.

The rendered services pin `WorkingDirectory` and `ExecStart` to an absolute release path. Changing `/opt/clockin-sniper/current` alone does not change the running or next-started binary and is not a rollback. Before step 4, confirm the previous unit can traverse the current `/etc/clockin-sniper` parent and write to `/run/clockin-status`. If the previous unit predates `clockin-status`, temporarily restore its recorded parent-mode boundary during rollback; never loosen `credentials/` or `wallets/`, and reapply the hardened parent only after the compatible unit is active.

If schema rollback is not explicitly supported by the migration ADR, restore neither an older binary nor an older database over current state. Use a forward fix.

## Acceptance evidence

A production deployment is complete only when a private receipt contains:

- host/region identity and time-sync state;
- source commit, package version, Node version, artifact SHA and checksum verification;
- rendered unit hash and `systemctl show` readback;
- directory/file modes without secret contents;
- `/health` and `/ready` responses;
- quoted-pad/WETH/creator/event/profile/adapter/config revisions and evidence IDs;
- 10/10 WETH balance, quoted-pad allowance, native-Gas and nonce readiness, without key material;
- active/observer lease state and failover drill result;
- redacted log/alert samples and rollback drill result.

Receipt absence means `NOT_DEPLOYED`, even if a process is locally runnable.
