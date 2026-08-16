# ADR 0006: ClockIn policy v2 risk, authorization and execution bounds

- Status: Accepted
- Date: 2026-08-16
- Owner: project owner
- Config revision: `clockin-policy-v2`, revision `2`
- Supersedes: [ADR 0005](0005-initial-strategy-policy.md)
- Related specification: [plan.md — resolved owner decisions](../plan.md#31-已冻结的用户决策clockin-policy-v2)

## Context

Policy v1 fixed the 10-wallet architecture, 50U principal, hybrid CA gate and principal-first profit logic, but deliberately left price freshness, cap resizing, downside exits, slippage and authorization lifetime unresolved. Those omissions correctly prevented owner-policy arming. The owner has now accepted the recommended values, with two explicit final choices: emergency exit slippage is at most 20%, and a pre-authorization is valid for at most one week.

This ADR completes the owner-controlled policy. It does not claim that the unpublished final mainnet Factory/ABI, wallets, cloud host or routes are ready.

## Decision

### Capital and entry sizing

- ClockIn entry principal remains 50U: 10 independent one-shot EOAs, each nominally at most 5U.
- All-in risk is capped at 60U after converting principal and reserved transaction costs to the same frozen native-asset basis. No automatic top-up is allowed.
- A legal per-transaction/per-wallet/global cap may shrink a lane below 5U (`SHRINK_TO_CAP`), but never below 1U. A remainder below 1U is skipped, not split or reallocated.
- A shrunk lane must obtain a fresh quote for that exact principal. A nominal-5U quote cannot authorize a 4U transaction.
- Global cap is consumed once across the selected lanes. Catch-up remains quote-ranked and bounded to two lanes per canonical block.
- The first official-launch strategy remains monitor-only at 0U. The optional micro-probe remains disabled by default.

### Price and authorization

- Native conversion uses a primary integer source plus an independent cross-source, frozen before arming.
- The price snapshot may be at most 30 seconds old and the two sources may deviate by at most 2% (200 bps).
- Manual fixed wei is an audited fallback only if frozen before arming; it cannot be injected on the launch hot path.
- Authorization is prepared before launch and then permits deterministic event-driven execution; no launch-time click is required.
- Authorization TTL is at most seven days (`604800000 ms`). Its hashes bind chain, deployment/profile, config revision/hash, wallet set, identity gate and the 50U/60U risk envelope. Scope mismatch or expiry fails closed.

### Downside and holding periods

- The initial stop uses the executable net liquidation value immediately after entry as its baseline, rather than gross cost. This prevents the known 40%→floor buy tax from causing an immediate false stop.
- Stop sampling starts only after the initial fee window has closed and a verified executable route exists.
- A 30% decline from that baseline triggers full exit only after two distinct consecutive canonical blocks confirm the condition.
- Before actual principal is recovered, the maximum holding period is 60 minutes. With a verified executable route, expiry exits all remaining tokens.
- After actual principal is recovered, the runner maximum holding period is 24 hours. The existing 25% executable-net peak drawdown remains active.
- Momentum-based exit is `DISABLED_UNTIL_REPLAY_V1`; an unvalidated momentum flag cannot liquidate a position.
- The existing 2× principal-recovery threshold and 3× second-profit trigger remain; the second profit sale is 10% of initial tokens.

### Slippage and liquidity

- Routine automatic and manual exits are capped at 5% slippage (500 bps).
- A separate `BREAK_GLASS` path may use at most 20% (2000 bps). It requires a fresh executable quote, an explicit operator justification, a second confirmation ID and an authorization audit ID bound into the exit plan.
- Routine logic never escalates itself into `BREAK_GLASS`; the 20% value is an absolute emergency ceiling, not an automatic target.
- When no verified economically executable route exists, the system alerts and retries verified routes. It does not manufacture a price or widen slippage without bound.

### Funding and topology

- Each wallet readiness calculation reserves one entry, one approval and up to three sells, then adds a 30% margin to those Gas costs.
- Aggregate principal plus reserved Gas must fit the frozen 60U all-in cap.
- Production topology is one active signer plus one keyless observer. Region selection remains benchmark-driven and requires a deployment receipt.

## Consequences

- `clockin-policy-v2` is complete at the owner-policy layer and has a stable config hash.
- Owner-policy completeness is necessary but insufficient for `HOT_ARMED`. The capability manifest remains `NOT_HOT_ARMED` until final official Factory/ABI and code identities are verified, executable buy/sell adapters pass fork/replay, 10 wallets are funded with clean nonces, a fresh price snapshot is frozen, and the approved cloud artifact is read back.
- Any change to these bounds requires a new config revision/hash, review, tests and readiness re-evaluation. It cannot mutate a frozen plan or active authorization.
