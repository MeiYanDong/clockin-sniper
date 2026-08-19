# CLOCKIN WETH hot-path and quoted dual-launch evidence — 2026-08-20

## Evidence status

`QUOTED_DUAL_SURFACE_OBSERVED / WETH_HOT_PATH_VERIFIED / CLOCKIN_CA_NOT_YET_OBSERVED`

Read-only snapshot: Robinhood Chain block `40,770,297`, block hash
`0xf54c7f76ebd245818735e4875341488d6431a9f87f8e5989b12585b944610290`, timestamp
`2026-08-20T02:21:54+08:00` (`2026-08-19T18:21:54Z`). The reads used the
[official public Robinhood Chain RPC](https://docs.robinhood.com/chain/connecting/), the current
StonkBrokers frontend bundle, verified Blockscout source and public project pages. No paid RPC,
wallet secret, signature or transaction broadcast was used.

This document records three different evidence levels:

- **OBSERVED**: reproduced from current official web content, verified deployed source, bytecode,
  transaction receipts or public-RPC state.
- **INFERENCE**: a consequence of the observed code and current UI sequence, but not yet a CLOCKIN
  transaction receipt.
- **UNKNOWN**: cannot be established until the real CLOCKIN launch is sequenced or the publisher
  changes a public surface.

## Primary correction: native `0xEcA...` is not the current CLOCKIN dual path

**OBSERVED.** The generic native-ETH `StonkSafeLaunchpad` at
[`0xEcA5726dae1e53365c37fFc02369d947A91d71f9`](https://robinhoodchain.blockscout.com/address/0xEcA5726dae1e53365c37fFc02369d947A91d71f9?tab=contract)
is deployed and real, but it is **not** the primary route selected by the current official CLOCKIN
dual-launch UI. Its native payable buy path and its generic public-floor launches must not be used
as the CLOCKIN production adapter merely because the launcher calls one lane an "ETH curve."

The current official frontend's dual-lane descriptors instead bind that "ETH" lane to a
**WETH-quoted** `StonkSafeLaunchpadQuoted`, and the other lane to a
**STONKBROKER-quoted** `StonkSafeLaunchpadQuoted`. This distinction changes the funding asset,
allowance path and exact `buy` ABI.

Current primary contract set:

| Role                                                           | Address                                                                                                                                               | Quote asset                                                                                                                                          | Deployment evidence                                                                                                                                                           | Runtime identity                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| CLOCKIN lane 1, UI label "ETH machine", actual WETH-quoted pad | [`0xABEa69101B2a19347A34339F24cAD8b9523E9c29`](https://robinhoodchain.blockscout.com/address/0xABEa69101B2a19347A34339F24cAD8b9523E9c29?tab=contract) | WETH [`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`](https://robinhoodchain.blockscout.com/address/0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73)        | [tx `0x225d...ee5f`](https://robinhoodchain.blockscout.com/tx/0x225d94ff0010fba0c7791b7f14b48da1f824ce4652f87119659f67b2481fee5f), block `40,100,279`, `2026-08-18T23:40:01Z` | `24,486` bytes; `keccak256(runtime)=0x8e29dcdde3a878f2384cbda5c2300e77d7fea299b79def5fd1be9d5700deda53` |
| CLOCKIN lane 2, STONK machine                                  | [`0x77103B69f680BCd3df75F7D7ed3a67030130736a`](https://robinhoodchain.blockscout.com/address/0x77103B69f680BCd3df75F7D7ed3a67030130736a?tab=contract) | STONKBROKER [`0xe934e36A439C94017B64a3FecE66AF12099aBF50`](https://robinhoodchain.blockscout.com/address/0xe934e36A439C94017B64a3FecE66AF12099aBF50) | [tx `0x5d16...5d0e`](https://robinhoodchain.blockscout.com/tx/0x5d16fb3a8406b87161f68f9603aeecb90fe8c8e3975e07d784c7c5c8f2af5d0e), block `40,099,005`, `2026-08-18T23:37:54Z` | `24,486` bytes; `keccak256(runtime)=0xc882dad9fed3441fac7f87394780f86a78ffb92443b85a17039d3cdcd1dc49f4` |
| Frontend-approved dual creator identity                        | [`0x5eb8d8492b6b710f29b72a0bbd6425241d408e06`](https://robinhoodchain.blockscout.com/address/0x5eb8d8492b6b710f29b72a0bbd6425241d408e06)              | N/A                                                                                                                                                  | Hardcoded by the current official bundle; current equality check gates the dual form                                                                                          | EOA at the snapshot, `nonce=0`, `balance=0`, Blockscout transaction list empty                          |

### WETH runtime snapshot receipt

**OBSERVED at block `40,770,297` (`0x26e1af9`).** An exact-block `eth_getCode` for
[`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`](https://robinhoodchain.blockscout.com/address/0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73)
returned non-empty runtime bytecode with
`keccak256(runtime)=0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353`.
At the same snapshot, the WETH quoted pad's `quote()` returned that exact address. The production
profile freezes both the address and this runtime hash; a changed or empty runtime fails closed
before discovery or signing. This receipt is independent of the pad runtime hash in the table above.

Both quoted pads were deployed by
[`0x3914e01a0B567535B3AAEFfC4E8265115383aE76`](https://robinhoodchain.blockscout.com/address/0x3914e01a0B567535B3AAEFfC4E8265115383aE76),
are verified as `StonkSafeLaunchpadQuoted`, and are reported as non-proxies by Blockscout. Their
verified API records are reproducible at
[`/api/v2/smart-contracts/0xABEa...`](https://robinhoodchain.blockscout.com/api/v2/smart-contracts/0xABEa69101B2a19347A34339F24cAD8b9523E9c29)
and
[`/api/v2/smart-contracts/0x7710...`](https://robinhoodchain.blockscout.com/api/v2/smart-contracts/0x77103B69f680BCd3df75F7D7ed3a67030130736a).

The approved creator is an **official-frontend identity anchor, not an onchain allowlist enforced
by the quoted-pad contracts**. That makes exact creator matching substantially stronger than a
name-only trigger, but it does not prove that the publisher cannot update the bundle, use another
wallet or call the contracts directly.

## Exact quoted launch discovery ABI

### Events and filter

**OBSERVED from both verified quoted-pad ABIs.**

```solidity
event LaunchCreated(
    uint256 indexed id,
    address indexed token,
    address indexed creator,
    bool externalToken
);

event LaunchArmed(
    uint256 indexed id,
    uint256 supply,
    uint256 vQuote0,
    uint64 quoteUsd8,
    uint64 deadline
);

event SafeBuy(
    uint256 indexed id,
    address indexed buyer,
    uint256 quoteIn,
    uint256 taxPaid,
    uint256 taxBps,
    uint256 tokensOut,
    uint256 mcapUsd8
);
```

| Event                                                              | `topic0`                                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `LaunchCreated(uint256,address,address,bool)`                      | `0xa4d3b2dc54656491295ce21a0b888cd8df38e69113e44371344da5088e480a43` |
| `LaunchArmed(uint256,uint256,uint256,uint64,uint64)`               | `0x617dff9af409b81e92edd8d62fb192f25509657b96d203585e3e6b605d4dea26` |
| `SafeBuy(uint256,address,uint256,uint256,uint256,uint256,uint256)` | `0xba22b06917da96d20a8f4f80d45cbdaaf3294856de78268558edcce22e4298df` |

The current production hot `LaunchCreated` filter is:

- `address`: exactly the WETH quoted pad `0xABEa...9c29`;
- `topics[0]`: quoted `LaunchCreated` topic;
- `topics[3]`: approved creator padded to 32 bytes,
  `0x0000000000000000000000005eb8d8492b6b710f29b72a0bbd6425241d408e06`.

The WETH event must emit `externalToken=false`. The STONK pad is not a second production execution
trigger and is not a funded route; after the WETH CA is known, a same-token STONK
`externalToken=true` event may be used only as asynchronous cross-identity evidence. Its absence or
failure cannot redirect WETH funds or block the current WETH strategy. The durable execution key is
`(WETH pad, launchId)`, not a globally unique numeric id; `launchIdOfToken(token)` remains a direct
same-pad cross-check.

`name` and `symbol` are not present in `LaunchCreated`. If needed for display or secondary identity
evidence, read `name()` (`0x06fdde03`) and `symbol()` (`0x95d89b41`) from the emitted token address at
the event block. A normalized name match alone is not sufficient: the generic floor already
contains unrelated CLOCKIN-named copycats.

### State tuple and selectors

`getLaunch(uint256)` selector: `0x5930d3ce`. It returns this exact `Launch` tuple order:

```text
address token
address creator
uint64  startMcapUsd8
uint64  gradMcapUsd8
uint16  startTaxBps
uint16  decayPerMinuteBps
uint16  creatorFeeBpsSnap
uint16  protocolFeeBpsSnap
uint32  windowSecs
uint64  startTime
uint64  deadline
bool    externalToken
bool    sellsEnabled
bool    armed
bool    graduated
bool    bonded
bool    aborted
uint256 loadedSupply
uint256 vQuote
uint256 vToken
uint256 realQuote
uint256 buyCount
```

Relevant read/write surface:

| Function                               | Selector     | Result / role                                                                                                                                                                          |
| -------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewLaunch(uint256)`                  | `0x98a179cd` | Returns `id`, the full core tuple, current `taxBps`, `mcapUsd8Now`, `tokensSold`, `oracleFresh`, `legs`, `pools`, `lockIds`, `lpQuote`, `lpFeeBpsSnap`, `closedAtTs`, and `bufferSecs` |
| `legsOf(uint256)`                      | `0x85c7604e` | Returns one quote leg: WETH or STONKBROKER for the corresponding pad                                                                                                                   |
| `currentTaxBps(uint256)`               | `0x2aa3dade` | Contract truth for the tax at the current block timestamp                                                                                                                              |
| `quoteBuy(uint256,uint256)`            | `0xf998a865` | Returns `(tokensOut, taxBps)` for the proposed quote input                                                                                                                             |
| `launchIdOfToken(address)`             | `0xa27d865a` | Cross-checks the token-to-launch binding on each pad                                                                                                                                   |
| `buy(uint256,uint256,uint256,bytes32)` | `0x4aaf6fa4` | Nonpayable quoted buy: `(id, quoteIn, minTokensOut, ref)`                                                                                                                              |

The buy function calls `quote.safeTransferFrom(msg.sender, pad, quoteIn)`. It is not a native-ETH
payable buy, and the source trade gate requires `msg.sender == tx.origin`. A helper-contract relay
therefore cannot be assumed to work.

The verified quoted-pad source has no per-transaction, per-wallet or global buy-amount cap and no
buy cooldown: neither `buy` nor `_tradeGates` reads a cap/cooldown storage field, and the verified
ABI exposes no corresponding getter. Production therefore records the source-bound modes
`capMode=NO_CAP` and `cooldownMode=NONE`; it does not translate an unknown cap into an effectively
infinite allowance. Any pad runtime-hash change invalidates that negative-source conclusion and
must fail profile verification before execution.

## Created → Armed → Buy timing

**OBSERVED in the current official frontend bundle.** The default dual launch is a sequential
multi-transaction flow:

1. Submit WETH-pad `createLaunch` for a new token.
2. Wait for its receipt and decode `LaunchCreated`; this is the first authoritative onchain CA.
3. Approve half of the new token supply to the WETH pad.
4. Call WETH-pad `arm`; `LaunchArmed` starts that lane's clock.
5. Create a STONK-pad launch using the same token as an external token.
6. Approve the creator's remaining token balance to the STONK pad.
7. Call STONK-pad `arm`; its clock starts independently.

The CA is available at step 2, but the lane is not buyable until step 4. An immediate buy on
`LaunchCreated` is therefore not the correct transition: discovery should store
`(pad, id, token)`, enter `ARMED_WAIT`, and react to the matching `LaunchArmed`. At that point it can
read `getLaunch`, `viewLaunch`, `currentTaxBps` and `quoteBuy` and submit an authorized buy without
waiting for X or a website refresh.

**INFERENCE.** Under the current UI path, the first WETH `LaunchCreated` normally precedes the first
buyable state by at least the creator's token-approval and arm confirmations. That gives the
runtime time to bind CA and live parameters; it does not authorize buying before `armed=true`.
The creator may call the contracts by another sequence, so event/state truth must override a fixed
wall-clock assumption.

## Actual funding and official UI buy path

**OBSERVED in the current frontend and verified source.**

For the WETH lane when the user enters native ETH, the UI performs:

```text
WETH.deposit{value: amount}()
  → quoteBuy(id, quoteIn)
  → allowance(owner, WETH-pad)
  → approve(WETH-pad, amount) when insufficient
  → buy(id, quoteIn, minTokensOut, ref)
```

If the wallet already holds WETH and has sufficient allowance, wrap and approve are skipped. The
current UI derives `minTokensOut` as `98%` of `quoteBuy` output. The direct pad call still requires
native ETH separately for gas.

For the STONK lane, the quote token is STONKBROKER. A wallet paying from native ETH first swaps into
STONKBROKER, then performs `quoteBuy → allowance/approve → buy`; a wallet already holding and
approving STONKBROKER skips the swap and approval. The pad does not expose `buyWithPermit`, and
`buy` has no permit argument. Pre-holding and pre-approving the exact quote asset is therefore the
shortest observed path.

Operational consequence: ETH alone funds WETH wrapping and gas but is not itself the quoted input
to the lane-1 `buy`; STONKBROKER is needed only if the strategy also intends to buy lane 2 directly.

## Tax mechanism: current default versus runtime truth

**OBSERVED in verified source.** `currentTaxBps(id)` computes:

```text
if not armed or graduated: 0
if elapsed < bufferSecs: 9999 bps
otherwise:
  minutesElapsed = floor((elapsed - bufferSecs) / 60)
  max(0, startTaxBps - minutesElapsed * decayPerMinuteBps)
```

**OBSERVED in the current official default dual form.** The intended CLOCKIN default presently
passes:

- `bufferSecs = 300` seconds;
- `startTaxBps = 3300` (33%);
- `decayPerMinuteBps = 100` (one percentage point per full minute);
- `windowSecs = 1980` (33 minutes);
- default starting market cap `$25,000` and graduation market cap `$375,000`;
- `sellsEnabled = false`.

Thus each lane is currently expected to spend its first five minutes after its own arm at `99.99%`,
then begin at `33%` and step down by `1%` per integer minute. The formula reaches zero only when
`block.timestamp == deadline`, while `_tradeGates` rejects every buy with
`block.timestamp >= deadline`. Zero tax is therefore not an executable state. Under the current
defaults the last buyable tax is `1%`, during the final minute before the deadline. This directly
supersedes the earlier assumed `40% → 0 in 120 seconds` model for the current quoted dual UI.

**INFERENCE.** The production planner must distribute ten targets from the observed start tax to
the lowest _reachable_ tax, then wait for the actual discrete onchain tax to cross each target. A
launch is authorized only when the actual `deadline - 1` interval contains at least ten distinct
executable tax states; otherwise multiple wallets could collapse onto the same high-tax state. For
the current regular `33%`, one-point-per-minute, `1980s` schedule, there are 33 such states and the
executable floor is `1%`. A different window that reaches zero before the strict deadline may have
an executable `0%` state and must not be rejected merely because the start tax is not divisible by
the decay. Exact lane times remain planning outputs rather than immutable launch facts.

The production schedule must first prove
`deadline == startTime + bufferSecs + windowSecs`, then derive its last executable minute as
`floor((windowSecs - 1) / 60)` and its floor as
`max(0, startTaxBps - lastMinute * decayPerMinuteBps)`. Each order uses live `currentTaxBps` plus
`quoteBuy`. Owner-configurable frontend defaults and onchain bounds can change before launch;
hardcoded 300 seconds, 33%, 1% or ten fixed timestamps must not be mistaken for state.

### Tax split is not an additional buy deduction

**OBSERVED in the verified WETH-pad source.** The buy path first computes
`tax = (got * taxBps) / BPS` and `net = got - tax`; only `net` is passed into the curve. The later
`_splitTax(..., tax)` call distributes that already-deducted `tax` among creator, protocol and LP
recipients using `creatorFeeBpsSnap`, `protocolFeeBpsSnap` and the remaining share. Those snapshot
fee fields are therefore an internal allocation of `SafeBuy.taxPaid`, not three extra deductions
stacked on top of `currentTaxBps`. Production binds and records them as evidence but does not add a
second friction charge.

## Production principal, quote and risk boundary

The one-shot preparation command may use Coinbase/Kraken only before arming. It freezes ten wallet
plans together, pre-wraps and approves a `10%` WETH buffer per wallet, and proves buffered principal
plus maximum wrap/approve/entry gas remains within the owner-approved `60U` all-in envelope before
the first transaction.

The paid executor has no Coinbase/Kraken dependency on its launch hot path. Once the exact
`LaunchArmed` is canonical, it reads `viewLaunch` at that exact Armed block and requires
`oracleFresh=true` together with the bound armed/non-aborted lifecycle state. The event's
`quoteUsd8` (USD x `1e8` per ETH) then freezes each at-most-`5U` input by integer floor:

```text
quoteInWethRaw = floor(5_000_000 USD-micros * 10^20 / quoteUsd8)
```

It buys only that exact value, not the 10% preparation buffer. Before arming lanes it also proves
`50U + ten maximum entry-gas charges <= 60U` at the same Armed oracle. If price drift makes the
new at-most-5U raw amount larger than the prepared WETH balance/allowance, readiness fails closed
with an instruction to refresh preparation; the executor never silently spends more than 5U.

Immediately before each local signature, after all canonical RPC reads, the executor revalidates
quote expiry, the exact quote-block hash, the active public handoff, and
`latest baseFeePerGas + authorized priorityFee <= authorized maxFee`. It then checks both root-owned
approval markers as the final awaited gate. The signed raw is durably snapshotted before any
broadcast. A restart may release a FROZEN/SIGNED plan only when that pre-broadcast snapshot and all
broadcast/effect evidence are absent; once the snapshot exists, nonce ownership remains fenced.

This scope is deliberately **production entry only**. The quoted WETH entry path is executable
without a verified sell route, but the generic exit service is not claimed to understand or execute
this quoted profile. Post-entry exit remains a separate, unresolved production capability.

## Trigger priority and X boundary

**OBSERVED.** The current project surfaces do not leak a CA in advance:

- [`clockin.win`](https://clockin.win/) loads
  [`/assets/index-lZIzeBWA.js`](https://clockin.win/assets/index-lZIzeBWA.js), whose current SHA-256
  is `d4b8619d54ccca9c663380394b4c8a01721d45264c1e6eea5235c08afb62467a`; it contains
  `contractAddress: "TBA — dropping at launch"` and no 40-byte EVM address.
- The official launcher page states that CLOCKIN uses a special dual Safe Launch and that the pools
  appear when they arm: [Stonk Launcher](https://www.stonkbrokers.cash/launcher).
- The current Safe Launch implementation is visible at
  [Stonk Safe Launch](https://www.stonkbrokers.cash/safe-launch). The inspected production chunk is
  [`4696-4bcb870dc3f9423c.js`](https://www.stonkbrokers.cash/_next/static/chunks/4696-4bcb870dc3f9423c.js?dpl=dpl_EJLmsPndPs5YjDS38FRKHPJDyQcf),
  SHA-256 `4bbe90f6c377b4d3ab62730bf92ace539f16e62461cd271d305d90cf13b8377d`.
- CLOCKIN's pinned X post says the official CA will be posted from that account **at launch** and
  that earlier addresses are fake:
  [official CA-at-launch post](https://x.com/clockincoin/status/2083006313941103093).
- The latest observed launch notice says CLOCKIN "launches today" but publishes no CA:
  [launch-today post](https://x.com/clockincoin/status/2090110804335194474).

Therefore the primary trigger is the creator-indexed `LaunchCreated` event from the exact WETH
quoted pad, followed by its matching `LaunchArmed` and state reads. A later STONK-pad event may only
cross-check the already discovered CA; it does not create a buy handoff. X and the website are
asynchronous identity/reconciliation channels, not the hot trigger. Waiting for an X post can only
add latency; using a name hit without the WETH pad and creator anchor admits existing copycats.

The official public Nitro sequencer feed,
`wss://feed.mainnet.chain.robinhood.com`, can be an optional `PRECONFIRMED` wake-up source for raw
`createLaunch` transactions. It is not a mempool and contains no receipt/event log; practical lead
over remote `eth_getLogs` is **UNKNOWN** until measured from the deployment region. Receipt/log and
contract state remain the reconciliation truth.

## Current no-launch readback

**OBSERVED at the snapshot block `40,770,297`.**

| Check                                      | Readback                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Approved creator `eth_getTransactionCount` | `0`                                                                                                               |
| Approved creator `eth_getBalance`          | `0 wei`                                                                                                           |
| Approved creator Blockscout transactions   | empty                                                                                                             |
| WETH quoted-pad `launchCount()`            | `2`                                                                                                               |
| STONK quoted-pad `launchCount()`           | `23`                                                                                                              |
| Official `/api/safe-launch/floor` refresh  | `334` rows at `2026-08-20T02:21:27.937+08:00`; no row with the approved creator or official CLOCKIN dual identity |
| `clockin.win` HTML/bundle                  | no 40-byte CA; still `TBA`                                                                                        |

Conclusion at this read-only timepoint: **the official CLOCKIN CA and its armed pool were not yet
observed on the quoted dual path**. This is a dated observation, not a claim that they remain absent
after the snapshot.

## Remaining unknowns at launch time

- **UNKNOWN:** the final CLOCKIN CA, the real WETH/STONK launch ids and the exact transaction hashes.
- **UNKNOWN:** whether the publisher will keep the current approved creator, both quoted-pad
  addresses, the current bundle and the default economics unchanged until broadcast.
- **UNKNOWN:** whether both lanes will complete; the UI explicitly supports resuming after lane 1
  succeeds and lane 2 fails.
- **UNKNOWN:** the final per-lane arm timestamps, current oracle state, actual quote outputs and
  whether the real launch overrides `sellsEnabled` or any economic defaults.
- **UNKNOWN:** whether the X announcement precedes, matches or follows either onchain arm. It must
  not be treated as a timing guarantee.

These unknowns are resolved by the exact quoted-pad `LaunchCreated`/`LaunchArmed` receipts and live
getters, not by assuming the native pad, guessing the name, or waiting for social publication.
