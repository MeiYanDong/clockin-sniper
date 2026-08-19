# Hardened systemd templates

These are deployment templates, not proof of a deployment. Replace every `@...@` placeholder only with an executable from an approved, checksum-verified release artifact. Do not point the v2 units at the legacy single-wallet `npm run live` entrypoint.

Every service that can read a paid RPC credential is gated by `/etc/clockin-sniper/PAID_RPC_APPROVED`. The file is created only after an explicit owner decision to enter a real-snipe preparation/transaction/recovery window. Executor is additionally gated by `/etc/clockin-sniper/PRODUCTION_ARM_APPROVED`, whose exact content is `CLOCKIN_PRODUCTION_ARM_APPROVED_V1`. The markers may be created during the reviewed preparation sequence, but neither marker is itself an `ENTRY_HOT_ARMED` receipt, readiness proof, or transaction effect.

Security boundaries:

- `clockin-observer` runs Control Sentinel with the hard-coded Robinhood official public HTTP endpoint; it receives no credentials of any kind, does not read Execution `strategy.env`, and cannot activate paid transport;
- `/etc/clockin-sniper/control.env` contains only non-sensitive timing/local status settings; use `deploy/control.env.example` as the reviewed template;
- `clockin-executor.path` is the only boot-enabled paid-side trigger: it watches only the valid-activation edge at `/var/lib/clockin-handoff/outbox/active.signal`; durable `current.json` pointers and reorg tombstones are canonical readback inputs but never path triggers; the executor service itself has no `WantedBy` and is not boot-enabled;
- Control durably commits public catch-up after every `<=2,000`-block chunk and publishes `cursor/confirmedHead/lag/caughtUp`; do not enable the path until `caughtUp=true`, and do not synthesize `active.signal` from an unverified stale pointer;
- a bounded paid Executor may stop after 15 minutes without `LaunchArmed`; keyless public Control continues watching the same id and writes a new valid signal when a late canonical Armed event arrives;
- the quoted executor strictly reads and validates that fixed handoff before it validates markers or reads any paid RPC/signer credential; the path event then starts the executor and its required reconciler, so neither paid consumer runs before public `LaunchCreated` handoff;
- `clockin-executor`, `clockin-reconciler`, and `clockin-exit` validate the exact root-owned paid marker before reading any paid RPC credential;
- `clockin-wallet-preparer` is a disabled one-shot unit for pre-wrapping WETH and granting an exact finite allowance; it validates both markers before reading any signer/RPC credential and conflicts with the executor;
- `clockin-executor` additionally validates the exact root-owned production-arm marker before reading any signer credential;
- Executor requires Reconciler but does not start the generic Exit service, which is unsupported for the quoted profile; the WETH quoted entry policy can expand lanes 2–10 only after the canonical canary, strong creator/pad binding, remaining-wallet readiness, and current reconciliation checks succeed;
- `/var/lib/clockin-handoff` is `root:clockin-status 0750`; tmpfiles must pre-create `outbox/`, `outbox/records/`, and `outbox/invalidations/` as `clockin-observer:clockin-status 2750`. It deliberately does not pre-create `active.signal`, because creation/replacement of that valid JSON file is the paid-side activation edge. Control refuses a missing or mismatched production layout, and verifies the exact owner/group/mode instead of relying on its `UMask=0077`; `current.json`, cursor, immutable records/tombstones, and the valid-only `active.signal` are explicitly normalized to `0640`, so `clockin-status` readers can traverse and read while only the keyless observer writes. The executor mounts the tree read-only;
- provision the system group `clockin-status` before applying tmpfiles; `/run/clockin-status` is non-writable `root:clockin-status 0750`, while `control/` is `clockin-observer:clockin-status 2750` and `paid/` is `clockin:clockin-status 2750`; each plane atomically replaces `0640` redacted status only in its own tier, while `credentials/` and `wallets/` remain `root:root 0700`;
- signer and vault material is copied by systemd into the per-service credentials directory, not exported as command-line arguments or environment values;
- `ProtectProc=invisible`, `ProtectHome=true`, `UMask=0077`, a strict filesystem, empty capabilities, and owner-only state/runtime directories reduce exposure;
- stdout/stderr goes to journald, but application-level redaction remains mandatory;
- restart/backoff recovers the process, while SQLite leases and UNKNOWN recovery prevent a second business intent;
- `journald-clockin.conf` is a host-level policy example and must be reviewed before installation because it affects the host journal globally.

Installation and artifact readback are documented in `docs/runbooks/production-deployment.md`.
