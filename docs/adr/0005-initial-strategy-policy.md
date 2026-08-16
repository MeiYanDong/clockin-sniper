# ADR 0005: Initial ClockIn strategy policy

- Status: Superseded by [ADR 0006](0006-clockin-policy-v2-risk-and-authorization.md)
- Date: 2026-08-16
- Owners: project owner
- Config revision: `clockin-policy-v1`
- Related specification: [plan.md — resolved owner decisions](../plan.md#31-已冻结的用户决策clockin-policy-v2)

## Accepted implementation choices

- ClockIn principal is capped at 50U: 10 independent one-shot EOA lanes × nominal 5U. Gas is separate.
- The first valid official launch strategy is monitor-only (`0U`) and cannot borrow the ClockIn budget.
- Identity authorization uses `HYBRID_CA_GATE`: lane 1 requires L2; lanes 2–10 require L3 from official CA or a launch-beforehand approved Factory + creator + metadata binding.
- A lane that cannot legally buy exactly 5U under the current cap is skipped (`STRICT_5U`); it is not silently resized or split.
- Cross-band catch-up uses `QUOTE_RANKED_BOUNDED`, at most two lanes per canonical block. Without trustworthy quotes it degrades to one lane per block.
- Initial profit-management calibration points are 2× executable economic value for principal recovery, 3× for a second 10% token sale, and 25% executable-net peak drawdown for the runner.
- Price conversion requires a primary integer source plus an independent cross-source and a frozen snapshot; manual fixed wei remains an explicitly recorded fallback.

## Still required before production arming

- maximum price-source age and allowed deviation;
- maximum holding time and deterministic momentum-failure rule;
- initial stop-loss policy;
- no-liquidity policy (the implementation never expands slippage without a bound);
- manual `EXIT_NOW` maximum slippage;
- final Factory/Profile/ABI and fork-derived catch-up calibration.

These unresolved parameters do not block implementing and testing the parameterized engine. They do block `GATE-A SPEC_READY` and any production `HOT_ARMED` state.

## Supersession note

On 2026-08-16 the project owner resolved the remaining price, holding, downside, slippage, authorization, sizing, Gas and topology choices. ADR 0006 freezes those decisions as `clockin-policy-v2`; this record remains the historical v1 context.

## Change control

Any budget, identity, cap, catch-up, quote, or exit threshold change creates a new config revision and hash. It cannot mutate an already frozen ExecutionPlan.
