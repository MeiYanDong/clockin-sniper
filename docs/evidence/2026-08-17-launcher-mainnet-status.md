# Stonk Launcher mainnet status — 2026-08-17 refresh

## Observation

At the 2026-08-17 refresh, the official public pages still do not provide the evidence required to freeze a ClockIn production Factory/Profile:

- [Stonk Launcher](https://www.stonkbrokers.cash/launcher) says both `STONK LAUNCHER COMING SOON` and `Coming soon`. It describes a planned Safe Launch and the economic shape of future launches, but does not publish a canonical mainnet Launcher Factory address, event ABI, buy/sell selectors, or ClockIn token address.
- [StonkBrokers documentation](https://www.stonkbrokers.cash/docs) identifies Robinhood Chain mainnet as `chainId=4663`, labels Stonk Launcher `COMING SOON ON MAINNET`, and describes create → sale → finalize into Uniswap V3.
- The same official contract-address table lists live Anvil, locker, Clock In distribution, and selected exchange contracts, but no mainnet Launcher Factory. The only explicitly named `Launcher Factory` remains in the `Testnet Archive (Hackathon Demo)` section, which says not to use those addresses on chain ID 4663 mainnet.

The launcher page also advertises a Safe Launch date and a 99-minute anti-snipe curve. That is not evidence that ClockIn uses the previously discussed 40%-to-0, 120-second profile. The production profile therefore remains uncreated until the exact final contract and getters prove the owner-approved mechanism.

## Decision

Status remains:

`OFFICIAL_MAINNET_LAUNCHER_FACTORY_AND_FINAL_ABI_NOT_PUBLISHED`

Consequences:

- do not copy the testnet Factory into production;
- do not derive a buy/sell ABI from screenshots, names, or historical projects;
- do not create a production authorization or `PRODUCTION_ARM_APPROVED` marker;
- keep Control monitoring live and keep execution units inactive;
- when an official address appears, capture the source, exact block, deployer, runtime/proxy/implementation hashes, event layout, getter results, executable buy/sell/finalize routes, and fork/replay receipt before arming.

## Evidence boundary

This is a dated public-page observation, not a cryptographically signed protocol release. No raw page snapshot or publisher signature was available, so tasks requiring an immutable source-content hash remain unchecked.
