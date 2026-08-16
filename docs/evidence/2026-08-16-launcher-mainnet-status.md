# Stonk Launcher mainnet evidence snapshot — 2026-08-16

- Evidence level: `verified_current` for the two official web pages below
- Observation date: `2026-08-16` (Asia/Shanghai)
- Scope: public Stonk Launcher status and public address table only
- No signing, transaction construction, broadcast, or wallet access occurred during this check

## Official sources

1. [Stonk Launcher](https://www.stonkbrokers.cash/launcher)
2. [StonkBrokers Documentation](https://www.stonkbrokers.cash/docs)

## Current facts

- The official Launcher page labels Stonk Launcher and the public 99-minute Safe Launch tool as “coming soon”. It says deploys remain sealed until the official opening.
- The official documentation describes the launcher lifecycle as create → sale → finalize, with configurable fixed-price, bonding-curve, or custom sales and a later Uniswap V3 pool.
- The public mainnet contract table does not list a Stonk Launcher Factory address.
- The only explicitly named Launcher Factory address is under “Testnet Archive (Hackathon Demo)”, and the page explicitly says not to use those addresses on chain ID 4663 mainnet.
- The public pages do not publish a final ClockIn token address, ClockIn launch pool, final launch event ABI, buy/sell ABI, fee getter ABI, finalize event, or verified external exit route.

## Consequence for authorization

The current repository may implement and test canonical models, monitoring channels, wallet isolation, entry/exit engines, same-raw recovery, and fixture adapters. It cannot truthfully create a mainnet `HOT_ARMED` FactoryProfile or claim an executable ClockIn buy/sell route from the public evidence above.

The following gates therefore remain open:

- `GATE-A SPEC_READY`
- mainnet Factory/Profile verification
- mainnet MechanismProfile verification
- mainnet EntryAdapter/ExitAdapter/FinalizeAdapter verification
- historical/mainnet fork buy → sell → finalize replay against the final contracts
- funded wallet readiness and any real receipt/effect gate

## BLOCKED_BY

`BLOCKED_BY: OFFICIAL_MAINNET_LAUNCHER_FACTORY_AND_FINAL_ABI_NOT_PUBLISHED`

Unblocking evidence must include, at minimum:

1. an official mainnet Factory address or canonical deployment receipt;
2. chain ID 4663 runtime/proxy/implementation hashes at an exact block;
3. final launch event and Pool read ABI;
4. buy, sell, preview/quote, cap/cooldown/EOA-only, finalize and migration semantics;
5. ClockIn creator/metadata binding or official CA evidence;
6. an executable pre-finalize or post-finalize sell route.

Names, symbols, screenshots, copied event topics, testnet addresses, `eth_sendRawTransaction` acceptance, and website market-cap values do not satisfy this boundary.
