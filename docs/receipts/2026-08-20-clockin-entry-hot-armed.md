# CLOCKIN quoted entry hot-armed receipt — 2026-08-20

## Decision

`ENTRY_HOT_ARMED / NO_LIVE_EFFECT / QUOTED_GENERIC_EXIT_UNSUPPORTED`

The quoted CLOCKIN entry plane is deployed and launch-ready on `47.251.28.201`. The keyless public Control is caught up, the valid-only systemd path is enabled and waiting, both production interlocks are present with the required ownership and mode, and all ten one-shot wallets have canonical WETH deposit and bounded-approval receipts plus current balance, allowance, nonce, and native-Gas readback.

This is a launch-before readiness receipt. No CLOCKIN contract address has appeared, no public handoff exists, no Executor/Reconciler process is running, and no buy receipt or entry `EffectRecord` exists. It does not prove a fill, token delivery, profit, position, sellability, or exit. The generic quoted Exit remains `UNSUPPORTED` and is not armed.

## Evidence classification

- `verified_current`: immutable release, systemd, Control, path/interlock, public cursor, current wallet balance/allowance/nonce/native-Gas, and no-handoff/no-paid-process readback from the production host.
- `historical_receipt`: the twenty canonical preparation transactions and their redacted append-only receipt.
- `tested`: Created→Armed discovery, valid-only handoff activation, quoted execution, restart/reconciliation, ten-lane planning, and fail-closed interlocks in the deployed source revision.
- `none`: post-launch canonical entry effect and canonical exit effect.

## Immutable deployment identity

| Field | Verified value |
| --- | --- |
| Source commit | `9014c45df1370112803110b64e683caab65d9ac4` |
| Release archive SHA-256 | `6f46419ff70c50e43b3b3105dd436c9a030087e85deecf93f9b65bb9833c1f0f` |
| `BUILD-METADATA.json` SHA-256 | `6bf1f858be2a975b60b1b893dfd859040db5deca4e142d486d3549c384ed0839` |
| Deployed capability revision | `17` |
| Deployed capability manifest SHA-256 | `bc26f6d42442c1d99f51097aab86000934b8266636294ce5a3e85f01501da888` |
| Host release readback | Release, source commit, archive, build metadata, capability revision, and capability hash matched the approved immutable deployment |

These hashes identify the deployed artifact. Later documentation-only changes do not rewrite this deployment identity.

## Current production runtime readback

| Surface | Current evidence | Result |
| --- | --- | --- |
| Control | `active`, PID `439288`, `KEYLESS_PUBLIC_HTTP_FAILOVER` | PASS — public/keyless observation only |
| Active public route | `BLOCKREQ_FALLBACK` | PASS — failover is active without Chainstack credentials |
| Public cursor | cursor `40914339`, confirmed head `40914339`, lag `0`, `caughtUp=true` | PASS |
| Public handoff | none | EXPECTED — CLOCKIN CA/Created has not appeared |
| `clockin-executor.path` | enabled, active, waiting | PASS — valid-only handoff activation is armed |
| Wallet Preparer | static, inactive, PID `0` | PASS — one-shot preparation is complete |
| Executor | static, inactive, PID `0` | PASS — no handoff, therefore no paid execution process |
| Reconciler | static, inactive, PID `0` | PASS — no handoff/attempt to reconcile |
| Generic Exit | static, inactive, PID `0` | REQUIRED — quoted generic Exit is unsupported |
| `PAID_RPC_APPROVED` | `root:clockin`, mode `0440` | PASS |
| `PRODUCTION_ARM_APPROVED` | `root:clockin`, mode `0440` | PASS |

The inactive paid services are the correct armed idle state, not a deployment failure. The public `active.signal` is absent because there is no canonical launch handoff. Repository tests and deployed systemd wiring establish that a future valid-only handoff starts the quoted Executor and Reconciler; this receipt does not claim that a real CLOCKIN handoff has already exercised that transition.

## Wallet preparation and chain readback

The one-shot preparer produced twenty canonical preparation transactions: ten WETH deposits and ten amount-bounded approvals to the exact quoted pad. The redacted production receipt is stored outside the repository at:

`/var/lib/clockin-sniper/weth-preparation-2026-08-19T21-45-10.870Z.ndjson`

The receipt is mode `0600`. It contains no private key or signed raw transaction.

At canonical block `40908857`, production readback showed:

- `10/10` wallets at nonce `2`, accounting for exactly one deposit and one approval per wallet;
- each wallet WETH balance `2407976970983877` raw;
- each wallet exact-pad allowance `2407976970983877` raw;
- each wallet retained a positive native balance for Gas;
- no preparation journal item remained unresolved.

This proves preparation effects and current entry readiness. It does not prove that any of the prepared WETH has been spent on CLOCKIN.

## Armed execution boundary

When a canonical `LaunchCreated` for the exact quoted pad, approved creator, expected metadata, and `externalToken=false` is observed and confirmed, Control may publish the valid-only handoff. The enabled path can then start the paid quoted Executor and Reconciler. The Executor must still correlate the same launch id with `LaunchArmed`, respect the `9999 bps` buffer, read current tax and quote state, and satisfy the existing pre-sign authorization, marker, base-fee, quote-freshness, nonce, budget, and canonical-handoff checks before any lane can sign or broadcast.

The ten prepared wallets make the ten-lane entry plan possible; they do not pre-authorize a transaction outside those runtime gates. A tx hash, provider acceptance, CA observation, or process state must not be reported as a trade.

## Outstanding event evidence and limitations

- CLOCKIN CA / canonical `LaunchCreated`: not yet observed.
- Same-id canonical `LaunchArmed`: not yet observed.
- Entry signing or broadcast: none.
- Canonical buy receipt, WETH delta, token delta, Gas attribution, and entry `EffectRecord`: none.
- Lanes 2–10 execution: none; they remain dependent on the canonical canary effect and fresh Reconciler/readiness gates.
- Generic quoted Exit: `UNSUPPORTED`; no automatic exit route is armed.
- Canonical sell/swap receipt and closed-position effect: none.

The next evidence upgrade is `CANONICAL_ENTRY_EFFECT_CONFIRMED`, and it can be issued only after a real launch produces a canonical receipt plus attributable WETH/token balance effects and an `EffectRecord`.
