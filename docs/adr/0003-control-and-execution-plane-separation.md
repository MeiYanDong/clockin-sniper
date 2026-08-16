# ADR 0003: Separate Control and Execution planes

- Status: Accepted for implementation
- Date: 2026-08-16
- Owners: project owner
- Related specification: [plan.md — Overall architecture](../plan.md#5-目标系统总体架构)

## Context

The final ClockIn Factory and CA may be published late or may change. The system needs continuous monitoring of known factories, topic-wide events, related deployers, website fields, and external liquidity. Some proposed workflows use AI to analyze unknown contracts and address clusters.

These activities are useful for early inference, but they have different trust and latency properties from deterministic transaction authorization. Letting a website parser, address score, or LLM directly control a signer would make false positives capable of moving funds.

## Decision drivers

- Keep AI, web scraping, and deep analysis out of the hot path.
- Detect a changed Factory before the final CA appears.
- Require deterministic chain/profile verification immediately before spending.
- Reduce the secret exposure surface.
- Allow observers and dashboards to scale without duplicating signers.

## Options considered

### One process with unrestricted access

Simple deployment, but weak privilege separation and unclear authorization boundaries.

### Separate Control and Execution planes

The Control Plane has no private keys and produces evidence/profile revisions. The Execution Plane owns keys and independently verifies chain identity, Factory/profile, strategy authorization, budget, nonce, and validity before signing.

## Decision

Use separate conceptual security planes from the first implementation. They may initially run as modules in one service, but interfaces, storage leases, capability declarations, and deployment credentials must permit later process separation without changing business semantics.

AI can rank or explain candidates; it cannot upgrade a Factory to spend-authorized status. Website/CA monitoring is asynchronous and cannot block or override a verified Factory hot path without an explicit identity conflict record.

## Consequences

### Positive

- Unknown-Factory discovery can be aggressive without granting spending authority.
- Most monitoring services and dashboards need no key access.
- Hot-path latency and inputs remain deterministic and measurable.

### Negative

- Profiles, revisions, evidence IDs, and independent re-verification add implementation work.
- Service health must distinguish Control readiness from Execution readiness.

### Follow-up evidence

- Tests prove Control Plane output alone cannot create a signed transaction.
- ExecutionPlan records the exact Factory/Profile/config revisions it independently verified.
- Production deployment readback shows observer services have no signer credentials.
