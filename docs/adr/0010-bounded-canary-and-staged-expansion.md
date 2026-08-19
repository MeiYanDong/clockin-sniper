# ADR 0010: Bounded 5U canary and staged capital expansion

- Status: Accepted
- Date: 2026-08-20
- Owners: project owner and engineering
- Related specification: [plan.md — bounded canary execution tiers](../plan.md#36-bounded-canary-execution-tiers2026-08-20)
- Supersedes: the all-lanes Exit startup ordering and all-or-nothing readiness clauses in [ADR 0007](0007-production-runtime-interlock-and-route-binding.md)

## Context

The original production interlock treated every ClockIn entry lane as if the full 50U deployment were about to execute. Executor startup and every pre-sign check therefore required both Reconciler and Exit to be current, all ten wallets to reserve entry and exit Gas, at least one verified exit route, and token/pool runtime hashes already present in the immutable profile.

That model protected the complete position, but it also erased the intended economic role of lane 1. The first 5U is both an early inventory attempt and a deliberately bounded live probe. Requiring an already proven sell path and an already allowlisted first-seen Pool before that one transaction can make the system miss the only useful observation window. Conversely, using “speed” to authorize the other 45U before a canonical effect or exit proof would turn a bounded experiment into an unbounded assumption.

The Launcher may expose both native ETH and STONKBROKER-quoted pools. Final multi-pool event and buy ABIs are not yet frozen. Requiring STONKBROKER inventory merely because an optional second quote route may exist would add approval, price and inventory risk to the critical path.

## Decision

### Two explicit execution tiers

The Executor distinguishes `BOUNDED_CANARY` from `FULL_DEPLOYMENT`.

`BOUNDED_CANARY` permits only ClockIn lane 1 and is immutable at:

- at most one attempt per launch;
- at most `5_000_000` USD micros of principal;
- exact chain, exact Factory runtime identity and exact Factory event provenance;
- at least L2 ClockIn identity;
- non-empty token and Pool runtime code read at the launch block, even when a first-seen hash is not yet allowlisted;
- successful exact-block fee/window/cap/cooldown/EOA-only/quote-asset reads and an executable `previewBuy` through the frozen buy ABI;
- a fresh 5U price snapshot, one ready signer/wallet/nonce, an owned WAL-backed execution lease, a current Reconciler and zero unresolved attempts;
- the existing authorization, arm marker, paid-RPC marker, encrypted payload and same-raw broadcast boundaries.

The current ten-lane deployment still binds and loads all ten pre-created signer credentials against the authorized manifest at Executor startup. "One ready signer/wallet/nonce" narrows the live funding and nonce-readiness gate to `entry-01`; it does not claim that the configured ten-key manifest or the remaining credential files may be absent. This preserves the existing authorization identity while avoiding a 50U funding/exit-readiness prerequisite for the 5U canary.

Executor validates the exact root-owned, non-group/world-writable production-arm marker before it reads any signer credential; relying only on systemd `ConditionPathExists` is insufficient.

The bypass is limited to prior token/Pool code-hash allowlisting and pre-existing exit readiness. It does not bypass Factory identity, buy calldata semantics, chain identity, budget, nonce ownership, signing authority or receipt reconciliation.

`FULL_DEPLOYMENT` controls lanes 2–10 and requires all of the following at the same time:

- a successful canonical canary EffectRecord with actual token delivery inside the configured drift bound;
- L3/L4 identity, including official CA confirmation;
- token and Pool runtime hashes present in the immutable profile allowlist;
- current Reconciler and Exit service status, matching profile/authorization, WAL state, zero unresolved attempts, ten exit-capable signers and at least one verified executable exit route;
- fully funded, clean-nonce wallets for lanes 2–10;
- a fresh exact-block quote for the exact principal of every dispatched lane.

A transient full-deployment gate failure returns a selected but unsigned lane to `DEFERRED`. It does not mark the lane terminal and does not reserve its principal permanently. Later lanes without a trustworthy quote remain deferred; the previous unimplemented “dispatch now and let downstream invent a minOut fallback” path is removed.

### Process ordering

systemd continues to require Reconciler before Executor, because a possibly submitted canary must always be reconciled. Exit is started as a parallel `Wants` dependency but is no longer a startup ordering dependency. Its current verified readiness is still mandatory before lanes 2–10.

### Quote-asset policy

Native ETH is the primary entry quote route. An ERC20-permit route, including a possible STONKBROKER pool, is optional and cannot block native readiness. The repository does not claim an executable STONKBROKER buy adapter until the final Pool address, event layout, ERC20 buy calldata and permit/spender semantics are verified. Therefore the operator does not need to pre-hold STONKBROKER for the native canary path.

The bounded-canary policy has its own stable hash and is included in the production authorization risk-envelope hash. An authorization created before this decision cannot silently authorize the new execution boundary.

## Consequences

- The earliest economically bounded 5U transaction no longer waits for a complete sell implementation or nine additional wallet funding checks.
- The accepted maximum loss from incomplete code-family/exit knowledge is explicit and cannot expand beyond one 5U canary.
- The remaining 45U still fails closed on canonical effect, code identity, identity confirmation, wallet, quote and exit evidence.
- A missing optional STONKBROKER route does not delay ETH execution or require speculative STONKBROKER inventory.
- This is tested code, not a live deployment receipt. Capability revision 12 remains `NOT_HOT_ARMED` until a real mainnet Factory/profile/authorization and the other current production gates exist.

## Evidence

Automated tests cover the 5U/one-attempt policy, canary-only wallet readiness, missing-Exit dependency behavior, first-seen non-empty code versus allowlisted expansion, deferred/retryable later lanes, exact-quote enforcement, full expansion evidence and systemd dependency ordering.
