# Public-RPC Control deployment receipt — 2026-08-17

## Evidence level and decision

`DEPLOYED_PUBLIC_MONITORING / NO_PAID_RPC_CAPABILITY / NOT_HOT_ARMED`

This receipt proves that the production Control process is running against the hard-coded Robinhood official public HTTP RPC and that the three services capable of reading paid RPC credentials are disabled and inactive. It does **not** prove an external Chainstack billing counter; zero Chainstack use is established here as a capability boundary from the deployed artifact, rendered unit, process environment, credential mount absence, and runtime snapshot. It does not authorize signing, broadcasting, or moving funds.

## Scope and immutable artifact

| Item | Verified readback |
|---|---|
| Host | `47.251.28.201`, SSH management port `2222` |
| Source commit | `f14fe3eb27efb205acb1e6ab31608aea63564af5` |
| Immutable release | `/opt/clockin-sniper/releases/f14fe3eb27efb205acb1e6ab31608aea63564af5` |
| Uploaded artifact SHA-256 | `56c3d27fec25562f7a644ff55bacf8ee4c3ca808f867383eb947ebdac2a58a9f` |
| Package version | `0.1.0` |
| Build Node | `v25.9.0` |
| Production runtime Node | `v24.19.0` from a versioned absolute path |
| Capability manifest | revision `6`, SHA-256 `697d5430826c3cf9ef2acb4c66527767fd6a0b61cad67f3e478925e5faed8653` |
| Readback window | `2026-08-17T07:15:58Z` through `2026-08-17T07:18:59Z` |

The prior immutable release `16d02f05a54a33bfd0bb8bbce627b1aef892a689` and pre-change unit copies remain available for rollback.

Installed entrypoint SHA-256 values:

| Entrypoint | SHA-256 |
|---|---|
| `dist/control-service.js` | `4a843218a7ce9fe528315ac690ef9899d4c0c21dc0ff67e862bebface76d4a96` |
| `dist/executor-service.js` | `6cc758b7adc2bb97314685cbfd83de803fca47a5f078eec9e892505356e58b34` |
| `dist/reconciler-service.js` | `a87ac25214f6b2c2a3620fbdd475868df3c5503171177e472b714c90745c3abd` |
| `dist/exit-service.js` | `e79c2f91d723b74eb813a449716322c12f5f45d5f77c0a797f8f0f37a062e7d6` |

Rendered unit SHA-256 values:

| Unit | SHA-256 |
|---|---|
| `clockin-control.service` | `0ebb286770a123271dc9e7e50b512564d675c4e7b37c759b22022d0c74ddc9d1` |
| `clockin-executor.service` | `1221e0b5e5c8d08ca65429cfc10c9f53dc824bdb9958f63b782a1ff7b6aacc18` |
| `clockin-reconciler.service` | `53d492b9574330c0179c5589edc77487f371b50757880716037bac673885856f` |
| `clockin-exit.service` | `f79451df06738496f46dadc21ae28d2629ec7dcf440d138f3913ab501b8aa1ef` |

## Public Control readback

At the final readback:

- `clockin-control.service` was `enabled/active/running`, main PID `228813`, with `NRestarts=0`;
- watchdog timestamps advanced over more than two 30-second intervals;
- `/health` returned HTTP `200`, `/ready` returned HTTP `503`, and `/dashboard` returned HTTP `200`;
- `503` was correct because final Factory/Profile, signers, Execution WAL/lease, entry/exit readiness and verified exit routes are unavailable;
- chain identity was `4663`; the observed head progressed from `38650322` to `38650758` during the held readback;
- three website fingerprints were present;
- the hourly public readiness pass reported 10/10 funded wallets, 10/10 clean nonces and all-in cap ready at that snapshot; this is observation evidence, not a transaction authorization.

The runtime snapshot explicitly reported:

```text
providerId=robinhood-public-http
endpointClass=OFFICIAL_PUBLIC_HTTP
monitoringPolicy.mode=OFFICIAL_PUBLIC_HTTP_ONLY
paidRpcCapability=false
headPollMs=2000
identityRefreshMs=300000
walletRefreshMs=3600000
```

The metered public counter increased from 56 to 78 during a 45-second held check while the head advanced. At `2026-08-17T07:18:56Z` it reported 121 total public calls: 88 `eth_blockNumber`, 2 `eth_chainId`, 1 `eth_gasPrice`, 10 `eth_getBalance`, and 20 `eth_getTransactionCount`. Those are requests to the official public endpoint, not Chainstack.

## Paid capability and signing boundary

Four independent deployed checks held:

1. Control's rendered unit had zero `LoadCredential` directives, zero `strategy.env` references, and exactly one optional `/etc/clockin-sniper/control.env` reference.
2. `/etc/clockin-sniper/control.env` was `0640 root:clockin-status` and contained only reviewed non-sensitive local settings; the Control process environment contained zero variable names matching RPC, Chainstack, credential, private-key, or wallet-key fields.
3. No per-service systemd credentials directory existed for the Control PID, and the runtime snapshot declared `paidRpcCapability=false`.
4. Executor, Reconciler, and Exit each had exactly one `PAID_RPC_APPROVED` condition, remained `disabled/inactive`, and had zero execution processes. Both `PAID_RPC_APPROVED` and `PRODUCTION_ARM_APPROVED` were absent.

No private key, mnemonic, wallet-key content, RPC credential value, authenticated endpoint, signed raw transaction, or secret environment value was read or printed during deployment. No transaction was constructed, signed, broadcast, or reconciled, and no wallet funding was changed.

## Current monitoring limit

Because the official final Launcher Factory/topic/profile is still unpublished, the deployed Control currently monitors public chain-head progress plus ClockIn/Stonk website fingerprints and low-frequency public wallet readiness. The repository contains tested exact/topic/address channels, but no production log filter may be invented or armed from fixture/testnet data. Once the final Factory/profile is verified, its exact public `eth_getLogs` cursor can be configured for cold observation; paid WSS still requires an explicit real-snipe window.

## Closing decision

The default 24×7 state is now public-only monitoring. A name, website change, CA, address-cluster observation, or candidate contract cannot start Chainstack or any funds service. The owner must explicitly open a real-snipe paid window, after which Reconciler/Exit require the root-owned paid marker and Executor additionally requires the independent production arm marker plus every existing readiness gate.
