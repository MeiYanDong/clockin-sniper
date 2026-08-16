import assert from "node:assert/strict";
import test from "node:test";

import { Interface, Wallet, ZeroAddress } from "ethers";

import {
  loadFactoryLiveRuntimeConfig,
  runDiscoveredLaunchPreflight,
  runFactoryReadinessPreflight,
  runtimeCodeHash,
  type Hex,
  type JsonRpcRequester,
  type RuntimeEnvironment,
  type StonkLaunchCandidate,
} from "../src/index.js";

const PRIVATE_KEY = `0x${"11".repeat(32)}`;
const WALLET = new Wallet(PRIVATE_KEY).address;
const FACTORY = `0x${"22".repeat(20)}` as Hex;
const TOKEN = `0x${"11".repeat(17)}666666` as Hex;
const POOL = `0x${"33".repeat(20)}` as Hex;
const factoryCodeHash = runtimeCodeHash("0x6000");
const poolAbi = new Interface([
  "function currentFeeBps() view returns (uint16)",
  "function inSniperWindow() view returns (bool)",
  "function windowMaxBuyBps() view returns (uint16)",
  "function currentWindowCap() view returns (uint256)",
  "function buyCooldownSecs() view returns (uint32)",
  "function eoaOnlySecs() view returns (uint32)",
  "function quoteAsset() view returns (address)",
]);

const env: RuntimeEnvironment = Object.freeze({
  CLOCKIN_LIVE: "true",
  ROBINHOOD_RPC_URL: "https://rpc.example/private",
  ROBINHOOD_WS_RPC_URL: "wss://rpc.example/private",
  CLOCKIN_PRIVATE_KEY: PRIVATE_KEY,
  CLOCKIN_EXPECTED_WALLET_ADDRESS: WALLET,
  CLOCKIN_LAUNCH_ID: "clockin-mainnet-launch",
  CLOCKIN_FACTORY_ADDRESS: FACTORY,
  CLOCKIN_FACTORY_RUNTIME_CODE_HASH: factoryCodeHash,
  CLOCKIN_BATCH_VALUE_WEI: "1000000000000000",
  CLOCKIN_GAS_LIMIT: "250000",
  CLOCKIN_MAX_FEE_PER_GAS_WEI: "10000000000",
  CLOCKIN_MAX_PRIORITY_FEE_PER_GAS_WEI: "1000000000",
});

const candidate: StonkLaunchCandidate = Object.freeze({
  factoryAddress: FACTORY,
  creator: `0x${"44".repeat(20)}`,
  tokenAddress: TOKEN,
  poolAddress: POOL,
  name: "ClockIn",
  symbol: "CLOCKIN",
  metadataUri: "https://clockin.win/token.json",
  imageHash: `0x${"55".repeat(32)}`,
  blockNumber: 101n,
  transactionHash: `0x${"66".repeat(32)}`,
  logIndex: 0n,
  source: "wss",
});

function requester(feeBps = 4_000): JsonRpcRequester {
  return {
    providerId: "preflight-rpc",
    async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      if (method === "eth_chainId") return "0x1237" as T;
      if (method === "eth_blockNumber") return "0x66" as T;
      if (method === "eth_getCode") {
        const target = String(params[0]).toLowerCase();
        return (target === FACTORY.toLowerCase() ? "0x6000" : "0x6001") as T;
      }
      if (method === "eth_getTransactionCount") return "0x7" as T;
      if (method === "eth_getBalance") return "0xde0b6b3a7640000" as T;
      if (method === "eth_getBlockByNumber") {
        return (
          params[0] === "0x65"
            ? { timestamp: "0x64", baseFeePerGas: "0x3b9aca00" }
            : { timestamp: "0x65", baseFeePerGas: "0x3b9aca00" }
        ) as T;
      }
      if (method === "eth_call") {
        const call = params[0] as { readonly to: string; readonly data: string };
        if (call.to.toLowerCase() === TOKEN.toLowerCase()) return "0x00" as T;
        const parsed = poolAbi.parseTransaction({ data: call.data });
        switch (parsed?.name) {
          case "currentFeeBps":
            return poolAbi.encodeFunctionResult("currentFeeBps", [feeBps]) as T;
          case "inSniperWindow":
            return poolAbi.encodeFunctionResult("inSniperWindow", [true]) as T;
          case "windowMaxBuyBps":
            return poolAbi.encodeFunctionResult("windowMaxBuyBps", [200]) as T;
          case "currentWindowCap":
            return poolAbi.encodeFunctionResult("currentWindowCap", [20_000_000n]) as T;
          case "buyCooldownSecs":
            return poolAbi.encodeFunctionResult("buyCooldownSecs", [20]) as T;
          case "eoaOnlySecs":
            return poolAbi.encodeFunctionResult("eoaOnlySecs", [90]) as T;
          case "quoteAsset":
            return poolAbi.encodeFunctionResult("quoteAsset", [ZeroAddress]) as T;
          default:
            throw new Error(`unexpected pool call ${parsed?.name}`);
        }
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

test("prewarms wallet/factory before CA exists, then binds discovered pool state and cooldown", async () => {
  const config = loadFactoryLiveRuntimeConfig(env);
  const readiness = await runFactoryReadinessPreflight(requester(), config);
  assert.equal(readiness.pendingNonce, 7n);
  assert.equal(readiness.factoryCodeHash, factoryCodeHash);

  const discovered = await runDiscoveredLaunchPreflight(
    requester(),
    config,
    candidate,
    readiness.pendingNonce,
  );
  assert.equal(discovered.windowStartedAtMs, 100_000);
  assert.equal(discovered.pool.currentFeeBps, 4_000);
  assert.equal(discovered.pool.buyCooldownSecs, 20);
  assert.equal(discovered.pool.quoteAsset, ZeroAddress);
  assert.equal(discovered.tokenBalanceBefore, 0n);
});

test("refuses the separate public 99-percent Safe Launch mechanism", async () => {
  const config = loadFactoryLiveRuntimeConfig(env);
  await assert.rejects(
    runDiscoveredLaunchPreflight(requester(9_900), config, candidate, 7n),
    /9900 bps exceeds configured 4000 bps/,
  );
});
