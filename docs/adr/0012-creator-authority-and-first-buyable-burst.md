# ADR 0012: Creator authority and first-buyable burst

- Status: Accepted
- Date: 2026-08-20
- Owners: Project owner, sniper runtime
- Supersedes: ADR 0010/0011 where they require exact token metadata or a canonical canary before lanes 2–10

## Context

The official CLOCKIN launch proved that the verified WETH Safe Launch pad and approved creator were already sufficient to identify the authorized launch. The production Control nevertheless required an exact token-name string before publishing its handoff. The real token returned `CLOCK IN`, while the implementation expected a different display form. The strong on-chain anchor passed, the weaker descriptive field vetoed it, and no wallet submitted a transaction.

Both official curves then graduated at the end of the 300-second anti-bot buffer. A ten-band decay strategy therefore had no executable lifetime. Waiting for a canary receipt before releasing the other nine wallets would have missed the only economically buyable block as well.

## Decision

1. The deterministic live identity anchor is the conjunction of chain, verified WETH pad, approved creator, primary `externalToken=false`, and canonical `LaunchCreated` receipt/log/block binding.
2. Token name, symbol, official site and X are asynchronous audit observations. They may alert, but may not veto or delay a candidate after the deterministic anchor passes.
3. A production authorization is one-shot for the first canonical primary launch from the authorized creator within its scope. A later launch requires a new authorization and interlock receipt.
4. The tax at the canonical signing block must be at most 5,000 bps. A higher dynamic start tax may decay into the authorized range; if the launch window never reaches that range it is `NO_SHOT`. The 9,999-bps buffer is never buyable.
5. At the first canonical economically buyable block, all ten prepared EOAs may concurrently submit one exact 5U WETH buy each. The aggregate principal remains 50U and the all-in risk cap remains 60U.
6. Every lane requires a current positive quote and the same bounded entry slippage. `minOut=1` is removed from the specialized burst path.
7. If the curve is already graduated, bonded, aborted or outside its deadline, the default result is `NO_SHOT`. External-pool chasing is outside this authorization.
8. Automated tests and replay fixtures remain release gates. They never count as a live execution receipt.

## Consequences

Benefits:

- eliminates false negatives caused by casing, whitespace, spelling, delayed X posts or unavailable metadata RPC calls;
- moves paid warmup to the earliest canonical creator event;
- matches the observed market structure where the full curve can disappear in the first buyable block;
- preserves bounded loss through fixed per-wallet principal, aggregate budget, quote/minOut, Gas, nonce and same-raw controls.

Costs and risks:

- the project deliberately accepts that the approved creator may issue an unexpected first primary launch during the authorization window;
- all ten lanes can pay tax up to 50%, instead of using one small economic probe before expansion;
- concurrent quotes share one pre-state, so some later transactions may revert under rapid curve movement rather than fill; the implementation must not weaken minOut to manufacture fills;
- there is no automatic quoted exit in the current product, and no automatic post-graduation external-pool chase.

## Required evidence

- exact Factory runtime/profile and approved creator;
- canonical `LaunchCreated` and same-id `LaunchArmed`;
- fresh launch state, oracle and positive quote at the buyable block;
- 10/10 WETH, exact allowance, native Gas and clean nonce readiness;
- current authorization/config/profile hashes and both live interlocks;
- canonical receipt/effect for any claimed live trade.
