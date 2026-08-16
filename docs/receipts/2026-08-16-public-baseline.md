# Public baseline receipt — 2026-08-16

## Outcome

- Repository: [MeiYanDong/clockin-sniper](https://github.com/MeiYanDong/clockin-sniper)
- Visibility: `PUBLIC`
- Default branch: `main`
- Initial commit: `2aa915bef7ce71d9eef410ad5df433647ac6fcb0`
- Initial CI: [run 31934252170](https://github.com/MeiYanDong/clockin-sniper/actions/runs/31934252170)
- CI conclusion: `success`

## Public scope

The initial commit contains 84 tracked files limited to:

- root project/governance files;
- `.github/` CI/CD and templates;
- `docs/` plan, todo, ADRs, and receipts;
- `clockin-sniper/` source, tests, package metadata, and safe examples;
- `scripts/` public-scope checking.

The following local workspace directories are explicitly ignored and were not published:

- `analysis/`;
- `sniper-engineering/`;
- `sniper-engineering-v1.5/`;
- `clockin-sniper/node_modules/`.

## Quality evidence

The initial CI used Node.js 24 and completed:

- locked dependency installation with `npm ci`;
- tracked-file public-scope scan;
- repository secret scan;
- Biome format check and lint;
- strict TypeScript typecheck;
- 70/70 passing tests;
- line coverage `87.41%` with an enforced `85%` minimum;
- branch coverage `65.69%` with an enforced `60%` minimum;
- function coverage `88.61%` with an enforced `80%` minimum;
- production dependency audit with zero reported vulnerabilities;
- npm package contents audit.

## Branch protection

`main` requires pull requests and these checks:

- `Format, lint, typecheck, test, and package audit`;
- `Conventional pull-request title`.

Protection also requires an up-to-date branch, linear history, resolved conversations, disallows force pushes and branch deletion, and applies to administrators. Because this is currently a single-owner repository, the mandatory approval count is zero; PR and required checks remain mandatory.

## Evidence boundary

Evidence level: `repository_record + tested + verified_current_github`.

This receipt proves public publication and CI quality only. It does **not** prove:

- final ClockIn Factory/CA/ABI;
- wallet funding;
- cloud deployment or active services;
- signing or broadcast;
- a live transaction receipt;
- an executable exit or positive expected value.
