# Wallet key lifecycle runbook

## Boundary

ClockIn execution keys live outside the repository. The current batch is stored under the user-owned external secret root and is represented by ten `entry-01`…`entry-10` key files plus a manifest containing only wallet ID, address, role, and chain ID.

Never paste a key into source, `.env`, issue, PR, chat, terminal command, ordinary log, SQLite, NDJSON, dashboard, alert, screenshot, or GitHub secret-scanning test fixture.

## Creation

```bash
cd /opt/clockin-sniper/current/clockin-sniper
npm run wallets:create -- /absolute/repository-external/entry-wallets-vN
```

The command creates a new directory and files with exclusive-create semantics. It fails instead of overwriting an existing batch. Output contains addresses and correspondence status only.

## Before funding

1. Verify the directory is mode `0700` and every key/manifest file is `0600`.
2. Run address-key correspondence locally without printing key material.
3. Record the public addresses in the private funding worksheet, not in this public repository.
4. Query chain ID 4663, latest/pending nonce, native balance, principal requirement, entry Gas, and exit Gas.
5. Fund only a batch whose provenance is trusted. A copied, previously exposed, or unexpectedly modified key is retired without funding.

## Rotation

1. Stop new entry and retain exit/reconciliation for any old open position.
2. Generate a new versioned directory; never reuse or overwrite the old directory.
3. Verify 10/10 correspondence and readiness.
4. Create a new wallet-manifest/config revision and config hash.
5. Activate the new batch only when the old batch has no UNKNOWN attempt and its positions are closed or explicitly handed to the exit service.
6. Remove the old batch from the active credential mount. Archive or destroy it according to the owner’s recovery policy.

## Compromise response

- Disable entry immediately.
- Do not delete canonical state, receipts, or audit history.
- Keep exit active only if doing so does not race an attacker; use a fresh current quote and explicit slippage.
- Mark every affected lane and balance as UNKNOWN until reconciled.
- Generate a new batch; never deposit into the compromised addresses again.

## Repository verification

Run both checks before every public push:

```bash
cd clockin-sniper
npm run secrets:check
node ../scripts/check-public-scope.mjs
npm pack --dry-run
```

`.gitignore` is defense in depth, not the secret boundary. The primary boundary is repository-external storage with owner-only permissions.
