# Keyless Control Deployment Receipt — 2026-08-16

## Outcome

The ClockIn keyless Control Sentinel is running continuously on the selected server. This is a real production monitoring deployment, not Shadow mode, but it is **not** a Hot Executor deployment and cannot sign or broadcast a valid transaction.

## Deployment identity

| Item | Readback |
| --- | --- |
| Host | `47.251.28.201`, Alibaba Cloud SWAS, `us-west-1`, Ubuntu 24.04 |
| Source commit | `61d9be5d7729e5f47e27d872fe9dc308d8cff911` |
| Artifact SHA-256 | `57f58e0d3f6463256cebd530d56e2beab8d62e95f798329a53dcfe31879e210d` |
| Dedicated runtime | `/opt/clockin-sniper/runtime/node-v24.19.0-linux-x64/bin/node`, `v24.19.0` |
| Release target | `/opt/clockin-sniper/releases/61d9be5d7729e5f47e27d872fe9dc308d8cff911` |
| Service | `clockin-control.service`, enabled, active/running |
| OS identity | `clockin-observer:clockin-observer`, non-root |
| Ops endpoint | `127.0.0.1:8787` only |

The release archive includes `npm-shrinkwrap.json`; production dependencies were installed with the dedicated Node runtime and `npm ci --omit=dev --ignore-scripts`.

## Live readback

At `2026-08-16T14:53:24.079Z`:

- chain identity was `4663`, head `38062335`, reported lag `0`;
- authenticated HTTP, authenticated WSS and the official Sequencer invalid-payload probe were ready;
- `/health` returned HTTP `200`;
- `/ready` returned HTTP `503`, `hotArmed=false`, as required while Factory/Profile and execution readiness are missing;
- 10/10 wallets were funding-ready and nonce-clean;
- every wallet held `0.0032 ETH`, aggregate `0.032 ETH`, with latest/pending nonce `0/0`;
- the current price/Gas model reported `allInCapReady=true` under the frozen 60U cap.

A manual systemd restart changed the PID and recovered to `/health=200`, `/ready=503`, `fundingReady=10`, active/running, with `NRestarts=0`.

## Secret and isolation evidence

- RPC HTTP/WSS values are root-only mode `0400` files loaded with systemd credentials; values were not printed or committed.
- Ten private-key files are root-only mode `0400` under `/etc/clockin-sniper/wallets`.
- Server-side key/address correspondence was `10/10 valid` without printing private keys.
- The Control unit mounts no private key and the `clockin-observer` user cannot read the wallet directory.
- The public address manifest is separately readable and contains no private key.
- `/proc` environment, command line and the Control journal contained no private-key, key-file or authenticated Chainstack URL pattern.
- The immutable release directory contains zero `entry-*.key` files.
- Upload staging copies were deleted after installation; the keys remain in the root-only production directory and the user's repository-external local backup.
- Existing localhost services on ports `8790`–`8793`, nginx and SSH remained active.

## Fail-closed boundary

- `/etc/clockin-sniper/PRODUCTION_ARM_APPROVED` is absent.
- No Hot Executor, Reconciler or Exit service was installed or enabled.
- Control reports `signerReady=0`, Factory `UNKNOWN`, no DB lease/WAL, entry disabled and no verified mainnet exit route.
- No transaction was signed, broadcast or simulated during this deployment.

The next production gate is not “turn on the private keys.” It is to freeze the official mainnet Factory/proxy/implementation identities, final buy/sell/finalize ABI and executable exit routes, then create a launch-bound authorization and deploy the execution services against the same evidence.
