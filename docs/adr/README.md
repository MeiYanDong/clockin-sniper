# Architecture Decision Records

ADRs record decisions that materially change system boundaries, money movement, identity, persistence, execution ordering, recovery, or deployment.

## Status values

- `Proposed`: under discussion and not yet an implementation constraint.
- `Accepted`: approved for implementation.
- `Superseded`: replaced by another ADR; the replacement must be linked.
- `Deprecated`: retained for history but should not be used in new work.

## Index

- [0000 — Template](0000-template.md)
- [0001 — Public repository and external secret boundary](0001-public-repository-and-secret-boundary.md)
- [0002 — Ten one-shot EOA entry lanes](0002-ten-one-shot-eoa-entry-lanes.md)
- [0003 — Separate Control and Execution planes](0003-control-and-execution-plane-separation.md)

ADRs are append-only historical records. Correct factual errors with a follow-up note or superseding ADR rather than silently rewriting the original decision context.
