# ClockIn policy v2 implementation receipt — 2026-08-16

## Outcome

- Evidence level: `implemented + locally_tested + public_pr_opened`
- Implementation commit: `48bd5161a00176306af674f219a5ddbdb09fc9a6`
- Public PR: [#8](https://github.com/MeiYanDong/clockin-sniper/pull/8)
- Strategy config: `clockin-policy-v2`, revision `2`
- Config hash: `sha256:a03505b3f0da3a92a5c45f70ff584ab26326ba9940996446325449392f7fb121`
- Capability manifest: revision `3`
- Production state: `NOT_HOT_ARMED`

## Local verification

`npm run verify` completed successfully against the implementation tree:

- 207/207 tests passed;
- line coverage `89.58%`, branch coverage `72.27%`, function coverage `94.70%`;
- current-tree and Git-history secret scans passed;
- Biome format/lint and strict TypeScript checks passed;
- production dependency audit found 0 vulnerabilities;
- build and `npm pack --dry-run` passed with capability manifest revision 3 and the new downside-policy export.

## Policy evidence

- Principal is 50U and aggregate all-in risk is 60U; automatic top-up is disabled.
- Cap resizing is 1U–5U, never split or reallocated, and requires a same-principal quote.
- Price policy is dual source, <=30 seconds old and <=2% divergent; fixed wei is pre-arm only.
- Authorization is scope-bound and expires after at most seven days; exactly seven days passes and seven days plus 1ms fails.
- Pre-principal downside exit uses a post-entry executable-net baseline, -30%, two consecutive canonical blocks and a 60-minute bound.
- Runner maximum holding is 24 hours with a 25% executable-net drawdown; momentum remains disabled until replay.
- Routine exits are capped at 5%. A 20% plan is possible only through an explicit `BREAK_GLASS` audit with second confirmation and cannot be reached by routine escalation.
- Wallet readiness reserves one entry, one approval and three sells plus 30% Gas margin, then applies the aggregate all-in cap.

## Evidence boundary

No wallet secret was read or published, no wallet was funded, and no transaction was signed or broadcast. This receipt does not prove a final mainnet Factory/ABI, an executable current exit route, a cloud deployment, a canonical entry/exit effect or positive expected value. Those remain independent blockers in [production-readiness.md](production-readiness.md).
