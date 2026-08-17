# RPC monitoring pause receipt — 2026-08-17

## Evidence level and decision

`RPC_MONITORING_PAUSED / ALL_UNITS_DISABLED_INACTIVE / NOT_HOT_ARMED`

At the owner's request, the production ClockIn client was stopped to halt excessive Chainstack RPC consumption. This was a reversible client-side pause: it did not delete the Chainstack endpoint, RPC credentials, wallet files, funded accounts, immutable release or systemd unit definitions.

## Action and readback

Target host: `47.251.28.201`, managed over SSH port `2222`.

The operator ran `systemctl disable --now clockin-control.service`. The immediate and held readback was:

| Check | Before | After |
| --- | --- | --- |
| `clockin-control.service` enabled state | `enabled` | `disabled` |
| `clockin-control.service` active state | `active` | `inactive/dead` |
| Control main PID | running | `0` |
| `clockin-executor.service` | `disabled/inactive` | `disabled/inactive` |
| `clockin-reconciler.service` | `disabled/inactive` | `disabled/inactive` |
| `clockin-exit.service` | `disabled/inactive` | `disabled/inactive` |
| Arm marker | absent | absent |

At `2026-08-17T06:20:59Z`, a second readback confirmed:

- zero processes owned by `clockin-observer`;
- zero processes owned by the execution identity `clockin`;
- no ClockIn systemd timer;
- no ClockIn entry in root cron;
- localhost `/health` was unreachable (`HTTP 000`), as expected for a stopped Control service.

No private key, mnemonic, wallet file contents, authenticated RPC URL, credential value, raw transaction or signed payload was read or printed. No transaction was signed or broadcast.

## Operational effect

Continuous ClockIn HTTP polling and WSS subscriptions from this production deployment have stopped. The system will not update chain head, Factory/CA candidates, price snapshots, readiness state, alerts or the Dashboard while paused. Any Factory/CA publication or launch event occurring during this interval can be missed.

The Chainstack endpoint itself was deliberately left intact so the pause does not delete credentials or affect an unknown external consumer. Restoring ClockIn monitoring requires an explicit owner instruction, `systemctl enable --now clockin-control.service`, and a fresh transport/watchdog/readiness readback. This receipt is not authorization to resume automatically or to start any execution service.
