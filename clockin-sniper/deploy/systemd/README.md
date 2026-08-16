# Hardened systemd templates

These are deployment templates, not proof of a deployment. Replace every `@...@` placeholder only with an executable from an approved, checksum-verified release artifact. Do not point the v2 units at the legacy single-wallet `npm run live` entrypoint.

The executor unit is additionally gated by `/etc/clockin-sniper/PRODUCTION_ARM_APPROVED`. That file is created only after the production-readiness receipt passes. Its presence is not itself a readiness proof.

Security boundaries:

- `clockin-observer` runs Control Sentinel and receives no signer credentials.
- provision the system group `clockin-status` before applying tmpfiles; it gives both service identities read-only directory traversal and access to redacted status files, while `credentials/` and `wallets/` remain `root:root 0700`;
- signer and vault material is copied by systemd into the per-service credentials directory, not exported as command-line arguments or environment values;
- `ProtectProc=invisible`, `ProtectHome=true`, `UMask=0077`, a strict filesystem, empty capabilities, and owner-only state/runtime directories reduce exposure;
- stdout/stderr goes to journald, but application-level redaction remains mandatory;
- restart/backoff recovers the process, while SQLite leases and UNKNOWN recovery prevent a second business intent;
- `journald-clockin.conf` is a host-level policy example and must be reviewed before installation because it affects the host journal globally.

Installation and artifact readback are documented in `docs/runbooks/production-deployment.md`.
