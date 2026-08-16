# ADR 0004: SQLite WAL as canonical runtime state

- Status: Accepted
- Date: 2026-08-16
- Owners: project owner
- Related specification: [plan.md — Canonical data model](../plan.md#16-canonical-数据模型)

## Context

Ten independent wallet lanes can reserve capital, sign, broadcast, become UNKNOWN, reconcile receipts, create wallet-level positions, and exit concurrently. NDJSON is useful as an audit export but cannot atomically enforce the 50U aggregate limit, one wallet/nonce writer, or one canonical launch identity.

## Decision

Use the Node.js 24 built-in `node:sqlite` driver and a repository-external SQLite database as canonical runtime state.

- Enable WAL, `synchronous=FULL`, foreign keys, and a busy timeout.
- Enforce mode `0600` for the database and `0700` for its parent runtime directory.
- Use `BEGIN IMMEDIATE` for capital reservation and writer-lease transitions.
- Store on-chain integers as canonical decimal strings.
- Preserve historical revisions and append-only audit events.
- Keep private keys and plaintext signed raw transactions outside SQLite.
- Retain NDJSON only as a read-only migration source and audit/replay export.

## Consequences

The store can enforce aggregate budgets and uniqueness across process restarts. Runtime deployment must back up the database together with the encrypted signed-transaction vault and must never place either in the public repository or npm artifact.

## Evidence

Automated tests cover forward/rollback migrations, WAL and file permissions, concurrent reservation, idempotent budget initialization, identity conflict, service fencing, restart recovery, and legacy NDJSON import.
