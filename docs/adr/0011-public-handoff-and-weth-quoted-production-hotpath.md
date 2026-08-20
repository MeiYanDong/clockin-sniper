# ADR 0011: Public handoff and WETH-quoted production hot path

- Status: Superseded in identity and entry policy by ADR 0012
- Date: 2026-08-20
- Owners: project owner and engineering
- Related specification: [plan.md — verified CLOCKIN quoted hot path](../plan.md#37-verified-clockin-quoted-hot-path-纠正2026-08-20)
- Supersedes: ADR 0010's native-ETH route, official-CA expansion gate, Exit expansion gate, and paid-service startup ordering for the current CLOCKIN launch

> Historical boundary: this ADR records the revision-17 design that was deployed before the
> 2026-08-20 launch. Its synchronous exact-metadata gate, canary-first expansion and ten tax-band
> schedule are no longer current policy. [ADR 0012](./0012-creator-authority-and-first-buyable-burst.md)
> makes the canonical Factory + approved creator event authoritative, treats metadata as asynchronous
> audit only, and authorizes a first-buyable-block 10×5U burst when the signing-block tax is at most
> 50%. The public/paid RPC boundary, WETH route and canonical reorg controls below remain applicable.

## Context

Verified official frontend code and verified mainnet contract source establish that the current CLOCKIN
dual-launch primary is the WETH-quoted Safe Launch pad, not the older native-payable launcher. The
pad emits `LaunchCreated` with token CA and launch id, then emits `LaunchArmed` when the curve is
configured. Its buy path is a direct EOA nonpayable call using pre-held WETH and a pre-existing
allowance.

The owner requires two properties that pull in opposite directions: learn the CA from chain before a
possibly delayed X post, and consume paid Chainstack RPC only during preparation, transaction, or
recovery. The system therefore needs a keyless public discovery plane and a durable boundary that
starts the paid plane without browser or human intervention.

The contract's default tax also corrects the original strategy premise. It uses a 300-second 9999-bps
buffer, then starts at 3300 bps and decays by 100 bps per full minute. The formula reaches zero only
at `deadline`, while the trade gate rejects `block.timestamp >= deadline`; zero tax is not buyable.

## Decision

### Chain-first CA discovery

- The 24×7 Control process uses only a fixed, keyless public HTTP pool. Robinhood's official endpoint
  is primary; a compiled BlockReq public route is used only after a transient official failure. No
  environment value or systemd credential can redirect the pool to Chainstack.
- It scans only the exact WETH quoted pad and `LaunchCreated` topic with the indexed approved creator.
- It rejects `externalToken=true` and reads exact `Clock In` / `CLOCKIN` token metadata at the event
  block. Metadata alone never authorizes a candidate.
- The STONK pad is not a second execution trigger or funded route. A same-token STONK event may be
  consumed later only as asynchronous cross-identity evidence; it cannot create or redirect a WETH
  execution handoff.
- It binds the exact receipt log and canonical block hash and waits two public blocks before publishing
  a handoff. The paid executor then repeats canonical receipt/log/block checks through Chainstack.
  X and the website remain asynchronous confirmation/conflict channels only.

### Durable reorg and boot behavior

- A handoff record contains pad, launch id, token, creator, transaction, log index, block number and
  canonical block hash.
- A current handoff can be invalidated only when the public RPC returns the same different canonical
  hash twice. The store writes an immutable tombstone, CAS-invalidates the pointer, persists a cursor
  rewind and then permits a replacement. Transient failures cannot invalidate or advance state.
- `clockin-executor.path` is the only boot-enabled paid-side trigger. It is ordered before Control;
  Control atomically re-signals an existing pointer on startup so a reboot cannot lose a prior event.

### Paid activation and wallet preparation

- No handoff means no paid Executor/Reconciler process and no paid credential read.
- Wallet preparation is an explicitly authorized one-shot production action. With the path disabled,
  each of ten EOAs wraps a bounded 5U-plus-buffer WETH amount and approves only the exact pad for the
  exact finite amount. Preparation uses durable encrypted same-raw recovery.
- After 10/10 readiness is proven, only the path is enabled. The handoff starts Executor, whose
  systemd dependency starts Reconciler. Neither service is manually prewarmed.
- Executor, Reconciler and Exit validate both `root:clockin 0440` approval markers at startup and during paid
  work. Signing/rebroadcast paths recheck them immediately before the operation.

### Execution schedule and restart

- The Executor binds paid discovery to every handoff coordinate and block hash, then waits at most 15
  minutes for same-id `LaunchArmed`.
- It reads launch economics dynamically. The ten targets span `startTaxBps` to the lowest tax reachable
  strictly before `deadline`. For the verified default this is 3300 to 100 bps; 0 bps is rejected as
  unreachable.
- The authorized launch must expose at least ten distinct executable positive-tax states. A profile
  such as 4000-bps start with a single 4000-bps decay step is rejected instead of dispatching all ten
  wallets at 40%.
- Verified source contains no buy-amount cap and no buy cooldown. The runtime-hash-bound profile
  records `NO_CAP` / `NONE` explicitly; `UNKNOWN` is never interpreted as an unlimited cap.
- Every lane is nominally 5U WETH and gets a current exact-principal quote and positive minOut before
  signing. The 9999-bps buffer is never buyable.
- Lane 1 is the bounded canary. Lanes 2–10 require its canonical EffectRecord, current zero-UNKNOWN
  reconciliation, matching authorization/profile and readiness of the remaining wallets. Official X
  confirmation and an Exit route do not block expansion.
- On restart, terminal lanes are restored from plans, attempts and canonical effects before funding
  checks. Spent WETH is not mistaken for failed readiness; remaining lanes retain strict balance,
  allowance, gas and nonce checks.

### Finite paid lifecycle

- Executor stops at Created-to-Armed timeout, authorization expiry, launch deadline or marker revoke.
- Reconciler permits same-raw replay only when both latest and pending nonce equal the attempt nonce,
  and it rechecks markers before broadcast.
- Exit is not boot-enabled. Authorization expiry or marker revoke stops it; unresolved exposure becomes
  a degraded handoff requiring renewed authorization or explicit human takeover, not an infinite paid
  polling loop.

## Consequences

- A delayed X post cannot delay CA discovery or buying.
- A false name, same-creator unrelated token, transient RPC error or shallow reorg cannot silently bind
  the 50U budget.
- Two public confirmations add a negligible delay relative to the 300-second non-buyable buffer while
  materially reducing pointer poisoning risk.
- The fastest production buy still cannot occur before `LaunchArmed` and the anti-bot buffer; this is a
  contract constraint, not a local safety delay.
- The current primary path needs WETH plus native gas, not STONK. The separate STONK quoted lane is not
  funded or traded by this strategy and is eligible only for asynchronous identity cross-checking.
- This ADR specifies tested behavior. Deployment, wallet preparation and canonical live trade receipts
  remain separate evidence states.

## Evidence

- [Quoted hot-path evidence](../evidence/2026-08-20-clockin-quoted-hotpath.md)
- Automated tests for public exact-metadata handoff, reorg replacement, boot replay, quoted discovery,
  dynamic reachable tax, restart recovery, preparation recovery, UNKNOWN nonce fencing and runtime
  marker revocation.
