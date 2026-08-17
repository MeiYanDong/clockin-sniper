# Public-RPC Control deployment receipt — 2026-08-17

## Evidence level and decision

`DEPLOYED_PUBLIC_MONITORING / NO_PAID_RPC_CAPABILITY / NOT_HOT_ARMED`

This receipt proves that the production Control process is running against the hard-coded Robinhood official public HTTP RPC and that the three services capable of reading paid RPC credentials are disabled and inactive. It does **not** prove an external Chainstack billing counter; zero Chainstack use is established here as a capability boundary from the deployed artifact, rendered unit, process environment, credential mount absence, and runtime snapshot. It does not authorize signing, broadcasting, or moving funds.

## Scope and immutable artifact

| Item | Verified readback |
|---|---|
| Host | `47.251.28.201`, SSH management port `2222` |
| Source commit | `f610f0e6e169f71acee574fe91a31a4eb5bfbd0e` |
| Immutable release | `/opt/clockin-sniper/releases/f610f0e6e169f71acee574fe91a31a4eb5bfbd0e` |
| Uploaded artifact SHA-256 | `731aa8b49d4a2c6ce47c430ac50f962ba7ffb6f7011caab55ad80624ea759958` |
| Package version | `0.1.0` |
| Build Node | `v25.9.0` |
| Production runtime Node | `v24.19.0` from a versioned absolute path |
| Capability manifest | revision `8`, SHA-256 `5a24c789ae6951d482ff1a3b0aee38fa2dbbb6a82c438a1f3cd612f84bc8eb7d` |
| Readback window | `2026-08-17T07:31:23Z` through `2026-08-17T07:33:20Z` |

The prior immutable releases `ebbd827be2989d8aa8b1a42871ab774bf530381b`, `f14fe3eb27efb205acb1e6ab31608aea63564af5`, and `16d02f05a54a33bfd0bb8bbce627b1aef892a689`, plus pre-change unit copies, remain available for rollback.

Installed entrypoint SHA-256 values:

| Entrypoint | SHA-256 |
|---|---|
| `dist/control-service.js` | `31286fa2dec1390c303536552aedd812123113214c3f34448c4c3a4d52937be7` |
| `dist/executor-service.js` | `6cc758b7adc2bb97314685cbfd83de803fca47a5f078eec9e892505356e58b34` |
| `dist/reconciler-service.js` | `a87ac25214f6b2c2a3620fbdd475868df3c5503171177e472b714c90745c3abd` |
| `dist/exit-service.js` | `e79c2f91d723b74eb813a449716322c12f5f45d5f77c0a797f8f0f37a062e7d6` |

Rendered unit SHA-256 values:

| Unit | SHA-256 |
|---|---|
| `clockin-control.service` | `623e75d3b805a49b47ad085cee8f6189ceff05899c7dc6c4f3ba4bf1144c4b7d` |
| `clockin-executor.service` | `671ceb40bd55679e5a221ebc4b5a7f8b914b00721c64510507629fcc1ae64bd3` |
| `clockin-reconciler.service` | `666fb06e02000badbda3a529f9bce6e0f82d718ece4546d9b308d91bd5fc94cd` |
| `clockin-exit.service` | `7caf7889d12d574ca23896c6e17de8619cafec2c8b077b8c8502a2d22f083eac` |

## Public Control readback

At the final readback:

- `clockin-control.service` was `enabled/active/running`, main PID `230707`, with `NRestarts=0`;
- watchdog timestamps advanced over more than two 30-second intervals;
- `/health` returned HTTP `200`, `/ready` returned HTTP `503`, and `/dashboard` returned HTTP `200`;
- `503` was correct because final Factory/Profile, signers, Execution WAL/lease, entry/exit readiness and verified exit routes are unavailable;
- chain identity was `4663`; the observed head progressed from `38659480` to `38660018` during the held readback;
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
minimumRequestIntervalMs=500
```

The metered public counter increased from 46 to 73 during a 55-second held check while the head advanced. At `2026-08-17T07:33:19Z` it reported 83 total public calls: 50 `eth_blockNumber`, 2 `eth_chainId`, 1 `eth_gasPrice`, 10 `eth_getBalance`, and 20 `eth_getTransactionCount`, with `throttledRetries=0`. The paced startup completed 10/10 wallet funding and nonce readiness without HTTP 429. Those are requests to the official public endpoint, not Chainstack.

## Public rate-limit correction

The first metadata-aligned restart exposed a genuine operational fault: the official public endpoint returned HTTP 429 during the concurrent 31-call wallet-readiness burst, leaving that cold snapshot missing while chain-head and website monitoring continued. No paid endpoint or execution service was used. The deployed revision 8 serializes all public JSON-RPC calls with a 500 ms minimum interval and permits only two HTTP-429 retries with one- and two-second backoff. Automated tests assert ordering, physical-request counts and retry counts; the final production restart completed the same readiness pass with zero retry and no unresolved 429.

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
