# ADR 0002: Ten one-shot EOA entry lanes

- Status: Accepted for implementation
- Date: 2026-08-16
- Owners: project owner
- Related specification: [plan.md — Wallet model](../plan.md#32-决策二钱包模型)

## Context

The current executor signs ten sequential nonces from one EOA. It correctly waits for canonical token delivery and a per-wallet cooldown before advancing, but this can extend a nominal two-minute fee window to roughly 180–200 seconds. One UNKNOWN nonce can also block the remaining nine transactions.

The discussed launch mechanism may enforce EOA-only access, a per-EOA cooldown, and per-wallet caps. A 155-wallet swarm was proposed externally, but the actual ClockIn principal budget is only 50U in ten 5U tranches.

## Decision drivers

- Preserve the requested ten 5U fee bands.
- Avoid a single nonce/cooldown lane becoming the global critical path.
- Keep the maximum ClockIn principal at 50U.
- Avoid contract-intermediary restrictions.
- Keep wallet/key/position/exit complexity proportional to the budget.

## Options considered

### One EOA with ten sequential nonces

Simple key management, but per-wallet cooldown, receipt gating, and UNKNOWN states serialize the complete plan.

### Ten EOAs with one entry each

Each wallet has an independent nonce and per-wallet cooldown. A failure is isolated to one 5U lane. It requires multi-wallet funding, persistence, and per-wallet exits.

### 155-EOA swarm

Maximizes address count but creates disproportionate secret, funding, Gas, reconciliation, and exit complexity for a 50U strategy.

### Intermediary batch contract

Convenient coordination but may violate EOA-only or anti-contract rules.

## Decision

Implement ten dedicated one-shot entry EOAs. Each wallet owns exactly one fee band and at most 5U principal. Gas is reserved separately. A lane in UNKNOWN keeps its reservation and wallet nonce lease but does not block unrelated wallets.

Tokens remain in their original wallets for the initial exit implementation. Consolidation is not permitted until transfer-tax, max-wallet, anti-bot, and allowance behavior are verified.

## Consequences

### Positive

- Per-wallet cooldown and nonce uncertainty no longer serialize all ten bands.
- Maximum loss and failure attribution remain lane-local.
- EOA-only execution remains possible.

### Negative

- Ten keys, balances, Gas reserves, leases, PositionLots, and exit paths must be managed.
- Aggregate budget/cap enforcement requires atomic persistence.

### Follow-up evidence

- Tests prove aggregate principal never exceeds 50U.
- Fork/replay compares one EOA and ten EOAs under the final cooldown/cap profile.
- A real effect is not claimed until each lane has a receipt and token delta.
