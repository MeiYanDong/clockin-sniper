# Hardened systemd templates

These are deployment templates, not proof of a deployment. Replace every `@...@` placeholder only with an executable from an approved, checksum-verified release artifact. Do not point the v2 units at the legacy single-wallet `npm run live` entrypoint.

Every service that can read a paid RPC credential is gated by `/etc/clockin-sniper/PAID_RPC_APPROVED`. The file is created only after an explicit owner decision to enter a real-snipe preparation/transaction/recovery window. Executor is additionally gated by `/etc/clockin-sniper/PRODUCTION_ARM_APPROVED`, which is created only after the production-readiness receipt passes. Neither marker is itself a readiness or transaction proof.

Security boundaries:

- `clockin-observer` runs Control Sentinel with the hard-coded Robinhood official public HTTP endpoint; it receives no credentials of any kind, does not read Execution `strategy.env`, and cannot activate paid transport;
- `/etc/clockin-sniper/control.env` contains only non-sensitive timing/local status settings; use `deploy/control.env.example` as the reviewed template;
- `clockin-executor`, `clockin-reconciler`, and `clockin-exit` validate the exact root-owned paid marker before reading any paid RPC credential;
- provision the system group `clockin-status` before applying tmpfiles; `/run/clockin-status` is setgid+sticky group-writable so each service can atomically replace its own `0640` redacted status without deleting another owner's file, while `credentials/` and `wallets/` remain `root:root 0700`;
- signer and vault material is copied by systemd into the per-service credentials directory, not exported as command-line arguments or environment values;
- `ProtectProc=invisible`, `ProtectHome=true`, `UMask=0077`, a strict filesystem, empty capabilities, and owner-only state/runtime directories reduce exposure;
- stdout/stderr goes to journald, but application-level redaction remains mandatory;
- restart/backoff recovers the process, while SQLite leases and UNKNOWN recovery prevent a second business intent;
- `journald-clockin.conf` is a host-level policy example and must be reviewed before installation because it affects the host journal globally.

Installation and artifact readback are documented in `docs/runbooks/production-deployment.md`.
