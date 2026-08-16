# Security Policy

## Supported versions

The project has not published a stable production release yet. Security fixes currently target the `main` branch.

## Reporting a vulnerability

Do not open a public Issue containing any of the following:

- private keys or seed phrases;
- authenticated RPC URLs or API tokens;
- signed raw transactions that are still valid;
- cloud credentials or deployment access;
- an exploitable vulnerability that could put funds at immediate risk.

Use the repository's private GitHub Security Advisory reporting flow. Include the affected commit, reproduction steps, impact, and a minimal redacted proof. Never fund a test wallet or broadcast a transaction merely to demonstrate a report.

## Secret boundary

Production keys, wallet backups, runtime databases, deployment environment files, RPC credentials, and signed-transaction vaults must remain outside the checkout. `.gitignore` is defense in depth, not the security boundary.
