# ADR 0009: Semantic official-site signals and priority public RPC scheduling

- Status: Accepted
- Date: 2026-08-18
- Owners: project owner and engineering
- Related specification: [plan.md — Control signal quality and scheduling](../plan.md#35-control-signal-quality-and-scheduling2026-08-18)

## Context

The first public-only Control deployment exposed two operational weaknesses that do not move funds but can reduce launch readiness:

1. it hashed the complete HTML response and emitted an `ACTION` for any byte change, so a framework build ID, script chunk or other non-semantic page mutation was indistinguishable from a newly published CA or an opened launch;
2. the hourly wallet-readiness pass submitted 31 logical JSON-RPC calls together. The physical limiter serialized them, but its FIFO promise chain still left a newly arrived two-second head poll behind the complete readiness backlog.

The system must preserve a single official-public physical rate limiter, keep Chainstack unavailable to Control, and avoid treating website content as transaction authorization.

## Options considered

### Continue hashing whole pages and using a FIFO queue

This is simple, but it spends operator attention on irrelevant page changes and lets low-frequency accounting work delay the primary head signal.

### Parse every website with a full browser and use separate RPC clients

A browser can recover rendered content, while separate clients can avoid queueing. It also adds a large runtime dependency and lets concurrent clients bypass the one global public-provider pacing boundary.

### Retain raw diagnostics, derive stable semantics, and prioritize one shared queue

This keeps byte-level evidence without making it actionable. A foreground/background scheduler preserves one physical request stream while allowing head and identity work to take the next available slot.

## Decision

### Official website observations

- Control retains a SHA-256 raw-body hash only as diagnostic evidence.
- Action decisions use a separate deterministic semantic projection: explicit launch-status phrases in visible text, ClockIn/Robinhood-chain markers, visible EVM addresses, and addresses in source fields labelled as Factory/token/contract/pool/CA.
- Script and style bodies are excluded from visible status parsing. An arbitrary address inside an unrelated bundle variable is not promoted to a candidate.
- A raw-only change emits no action. Launch-status transitions and candidate-address set changes emit `ACTION`; other semantic-marker changes emit `INFO`.
- Candidate addresses remain `unverified`. They are exposed in the redacted snapshot and candidate count, but they do not become a Factory profile, create an authorization or marker, start a paid service, load a signer, sign, or broadcast.
- If Control starts while an official page already contains candidates or reports an open launch, startup emits an action instead of silently treating it as an inert baseline.

### Public RPC scheduling

- `PublicControlRpc.request()` is foreground work for chain-head and identity observation.
- `PublicControlRpc.requestBackground()` is for hourly Gas/balance/nonce readiness.
- Both classes share the same hard-coded official endpoint, 500 ms physical minimum interval, request accounting and bounded HTTP-429 retry behavior.
- After the currently in-flight physical call finishes, the scheduler always selects an available foreground request before the next background request. It does not cancel an in-flight request or manufacture concurrency.
- Snapshot metering exposes foreground/background physical counts, current queue depths and maximum observed background depth.

## Consequences

### Positive

- Framework-only page churn no longer looks like a launch signal.
- A real status or candidate-address change remains visible and auditable without becoming authority.
- A 31-call readiness pass cannot occupy 15+ seconds of FIFO positions ahead of a newly arrived head poll.
- One limiter continues to enforce the public-provider cost/rate boundary; Control still has no paid fallback.

### Negative

- Phrase and labelled-field parsing is deliberately narrow. A radically redesigned site may remain `UNKNOWN` until its parser rules are updated.
- Foreground priority can extend the completion time of an hourly readiness pass while two-second head polling is active.
- A foreground request can still wait for one already in-flight request and its bounded retry. This scheduler is not a latency guarantee and does not replace paid WSS in an explicitly approved real-snipe window.

## Verification

- Unit tests prove raw-only HTML changes preserve the semantic hash, launch transitions change status, candidate additions/removals are exact, and arbitrary bundle addresses are ignored.
- Unit tests hold one background request in flight, enqueue more readiness work and then enqueue a head request; the observed physical order must be background-in-flight, head, remaining background.
- Production readback must show the new semantic snapshot fields, foreground/background accounting, advancing head/watchdog, and unchanged `OFFICIAL_PUBLIC_HTTP_ONLY` / `paidRpcCapability=false` boundaries.
