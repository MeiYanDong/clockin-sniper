# Active/observer failover runbook

## Topology

Run one active deployment and one or more keyless observers. Observers ingest and validate evidence but do not receive wallet/vault credentials and cannot sign. A SQLite-backed service lease fences the single active writer.

## Planned takeover

1. Disable new entry on the active host while leaving reconciliation and exit available.
2. Reconcile every nonce slot and require zero unresolved `UNKNOWN` attempts.
3. Stop the active writer and verify its lease is expired or explicitly released.
4. Transfer the current canonical database and encrypted vault through an authenticated, integrity-checked channel. Never transfer plaintext raw transactions or keys in logs/commands.
5. Mount credentials on the candidate active host and verify key/address correspondence locally.
6. Run full production readiness, acquire the active lease, and only then enable entry.
7. Record source/destination artifact SHA, database integrity result, lease owner, pending/latest nonces, and readiness receipt.

## Unplanned loss

Fail closed. An observer must not take over merely because health checks fail. First establish lease expiry, database/vault currency, and all wallet pending nonces from at least two independent RPC views. Any signed or broadcast attempt without a canonical receipt remains `UNKNOWN`; replay only the byte-for-byte same raw transaction under its original validity envelope, or let it expire and reconcile effects before creating another intent.

## Drill acceptance

A drill passes only when two simultaneous active writers are impossible, the observer remains keyless, an unresolved nonce blocks takeover, and a clean takeover preserves EffectRecord/position counts. A design document or unit test is not a real regional failover receipt.
