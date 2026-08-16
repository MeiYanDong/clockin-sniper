## Story card

- TODO ID:
- Related spec/ADR:

## What changed

Describe the smallest user-visible or engineering outcome delivered by this PR.

## Why

Explain the requirement, defect, or evidence that makes this change necessary.

## Scope

- Included:
- Explicitly excluded:

## Risk and money-movement impact

- Does this change identity, budget, nonce, signing, broadcast, receipt, position, or exit behavior?
- Maximum affected scope: none / intent / wallet lane / strategy / service.
- Rollback or disable path:

## Verification

- [ ] `npm run verify`
- [ ] Relevant unit/integration tests added or updated
- [ ] Coverage remains above line 85%, branch 60%, function 80%
- [ ] Failure paths have meaningful assertions
- [ ] No private key, credentialized RPC, wallet backup, runtime data, or signed raw transaction is present
- [ ] `npm pack --dry-run` contents reviewed

Paste concise command results or link the CI run.

## Documentation

- [ ] CHANGELOG updated when behavior changes
- [ ] Tech spec updated when requirements change
- [ ] ADR added/updated when architecture changes
- [ ] Capability manifest reflects actual evidence level
- [ ] No documentation change is required, with reason

## Evidence boundary

State whether the result is planned, repository code, tested, historical receipt, or verified current runtime. Do not describe RPC acceptance or a passing test as a live trade.
