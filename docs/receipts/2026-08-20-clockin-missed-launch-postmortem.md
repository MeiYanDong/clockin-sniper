# 2026-08-20 CLOCKIN missed-launch postmortem

## Evidence level

`CANONICAL_LAUNCH_OBSERVED / ZERO_LOCAL_BUY_EFFECT / ROOT_CAUSE_REPRODUCED / EXPIRED_AUTHORIZATION_REVOKED`

This receipt records a real mainnet launch and a real missed execution. It does not claim a buy, position, profit, deployment of the creator-first fix, or an executable automatic exit.

## Canonical launch facts

| Field            | WETH primary launch                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Network          | Robinhood Chain, `eip155:4663`                                                                                                                         |
| Pad              | `0xABEa69101B2a19347A34339F24cAD8b9523E9c29`                                                                                                           |
| Approved creator | `0x5eB8d8492B6B710f29B72a0BBd6425241d408e06`                                                                                                           |
| Launch id        | `39`                                                                                                                                                   |
| Token CA         | `0xA5bE0EeB82A013dc7867B9E020C36A69DA666666`                                                                                                           |
| Token metadata   | name `CLOCK IN`, symbol `CLOCKIN`, decimals `18`                                                                                                       |
| Created          | block `41155080`, tx [`0x5b87e85a…cf288`](https://robinhoodchain.blockscout.com/tx/0x5b87e85a5908d4dc44e2e5978e01aef2c3d08b05ae745d0c091a1a87ee5cf288) |
| Armed            | block `41155180`, tx [`0xe7dbc633…a1397`](https://robinhoodchain.blockscout.com/tx/0xe7dbc63397eb1ce997a54a9bb0b5bb9301d256b5f4ab81190afb26ea2bea1397) |
| Armed economics  | `3300 bps` start tax, `100 bps/min` decay, `300 s` buffer, `1980 s` window                                                                             |
| Curve outcome    | graduated/bonded at the end of the anti-bot buffer; `buyCount=200`                                                                                     |

The same CA was subsequently created as the external token on the STONK quoted pad under launch id `71`. That cross-lane event is corroboration, not the primary authorization key.

## Local execution effect

Read-only mainnet reconciliation after the launch found all ten configured entry wallets at `latestNonce=2`, `pendingNonce=2`, and CLOCKIN balance `0`. No repository receipt, signed-attempt record, canonical buy receipt, WETH delta, token delta, or `EffectRecord` exists for this launch.

Therefore the only truthful effect classification is:

```text
MISSED_ZERO_BUY
```

## Reproduced root cause

The deployed public Control had already matched the exact WETH pad, `LaunchCreated` topic, approved creator and `externalToken=false`. Before publishing the handoff it synchronously required token name `Clock In`. The canonical token returned `CLOCK IN`. That case-sensitive descriptive-field mismatch rejected the otherwise authorized event, so `current.json`/`active.signal` were never created and the paid Executor never started.

The defect is an authority inversion: a weak descriptive field vetoed a stronger deterministic identity anchor. The corrected invariant is:

```text
verified factory + approved creator + canonical primary LaunchCreated
    => authorization candidate is frozen

name / symbol / website / X
    => asynchronous audit only; never veto or delay
```

## Market-timing consequence

The WETH curve closed at the first economically buyable instant when its 300-second `9999 bps` buffer ended. The STONK curve closed roughly two seconds later. There was no surviving ten-band decay interval. A canary-first design that waited for lane 1 receipt before releasing lanes 2–10 would also have missed the executable window.

The replacement policy is therefore the first canonical block whose current tax is at most `5000 bps`: ten independent EOAs may concurrently submit one exact-5U WETH buy each, with a 50U principal cap, 60U all-in cap, positive current quotes and bounded `minTokensOut` for every lane. Higher initial tax is allowed only if the live window later reaches the `<=5000 bps` execution boundary. `9999 bps` remains unbuyable.

## Revocation and present boundary

After confirming that both curves had graduated and no local transaction existed:

- `clockin-executor.path` was disabled and stopped;
- Executor, Reconciler and generic Exit were stopped;
- `PAID_RPC_APPROVED` and `PRODUCTION_ARM_APPROVED` were moved recoverably under root-owned `/root/clockin-revoked-markers/` with an expired-CLOCKIN suffix and mode `0400`;
- keyless public Control remained the only running observation process;
- no new authorization or marker was created.

The deployed revision-17 artifact is historical and must not be described as creator-first or armed. The creator-first v3 source requires a new immutable artifact and a new one-shot profile/authorization before any future real launch. A stale handoff pointer from this consumed launch must be archived or isolated by a new authorization scope before re-enabling the path.

## Decision record

The accepted replacement policy is [ADR 0012](../adr/0012-creator-authority-and-first-buyable-burst.md). The implementation backlog is STORY-124 in [todo.md](../todo.md).
