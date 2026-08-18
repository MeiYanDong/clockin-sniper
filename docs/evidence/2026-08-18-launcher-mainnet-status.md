# Stonk Launcher / ClockIn mainnet evidence — 2026-08-18

## Evidence level

`OFFICIAL_WEB_CURRENT / NO_FINAL_MAINNET_LAUNCHER_FACTORY_OR_CLOCKIN_CA`

Observed at approximately `2026-08-18T05:00:00Z`. This is public discovery evidence, not a production profile, authorization, transaction receipt or economic effect.

## Official-source readback

| Source | Current observation | Meaning |
|---|---|---|
| [Stonk Launcher](https://www.stonkbrokers.cash/launcher) | Main Launcher heading and description say `COMING SOON` / `signal scrambled`; the same page separately says Safe Launch and several Special Projects are live | A generic `live now` or `Buy` phrase on this page cannot mean the main Launcher is open |
| [StonkBrokers documentation](https://www.stonkbrokers.cash/docs) | Network is Robinhood Chain mainnet `4663`; the live address table lists Anvil, Safety Deposit and Exchange contracts, but no mainnet Launcher Factory | No official mainnet Factory address is available to freeze |
| [StonkBrokers documentation](https://www.stonkbrokers.cash/docs) | Stonk Launcher is labelled `COMING SOON ON MAINNET`; ABI Quick Reference names `createLaunch / finalizeLaunch` and calls LauncherFactory `upcoming` | Function names are insufficient to construct the final launch/buy/sell adapter or an event filter |
| [StonkBrokers documentation](https://www.stonkbrokers.cash/docs) | `0x631f9371Fd6B2C85F8f61d19A90547eE67Fa61A2` appears only in `Testnet Archive (Hackathon Demo)` with an explicit “Do not use on mainnet” warning | This address must not be copied into a production profile |
| [ClockIn](https://clockin.win/) | Current raw page contains a ClockIn marker but no extracted launch status or candidate address | No official ClockIn token CA is available from the fallback page |

The documentation's repository link returned 404 to the unauthenticated public reader during this check, so the claimed full ABI directory was not publicly retrievable from that route.

## Deployed-parser fixture readback

The candidate semantic parser was run directly against the three current public responses before deployment:

```text
stonkbrokers.cash/launcher   status=COMING_SOON candidates=0 markers=COMING_SOON,SIGNAL_SCRAMBLED,SAFE_LAUNCH_OPEN
stonkbrokers.cash/safe-launch status=UNKNOWN    candidates=0
clockin.win/                 status=UNKNOWN     candidates=0 clockInMentioned=true
```

This caught and corrected a real false-positive case before production: a page-wide `live now` rule classified Safe Launch/Special Projects as the main Launcher. The accepted parser now binds status interpretation to `LAUNCHER`, `SAFE_LAUNCH` or `CLOCKIN` scope.

## Arming conclusion

The owner has authorized preparation for real execution, but authorization does not supply missing protocol identity. The following pre-execution gates remain blocked:

- official mainnet Launcher Factory address and exact deployment block;
- runtime/proxy/implementation identity and final launch event ABI/topic mapping;
- ClockIn token/pool identity binding;
- exact buy, preview/fee/cap/window and finalize semantics;
- verified inner and external sell routes with executable quote semantics;
- immutable production profile, current <=7-day authorization and historical fork/replay bound to that final profile.

Therefore `PAID_RPC_APPROVED` and `PRODUCTION_ARM_APPROVED` must remain absent, paid services remain inactive, and no signing or broadcast is allowed. Public semantic monitoring may be upgraded without crossing this boundary.
