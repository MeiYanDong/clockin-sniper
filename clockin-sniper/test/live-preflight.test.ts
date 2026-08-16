import assert from "node:assert/strict";
import test from "node:test";

import { Wallet } from "ethers";

import {
  loadLiveRuntimeConfig,
  runLivePreflight,
  type JsonRpcRequester,
  type RuntimeEnvironment,
} from "../src/index.js";

const PRIVATE_KEY = `0x${"11".repeat(32)}`;
const WALLET = new Wallet(PRIVATE_KEY).address;
const POOL = `0x${"22".repeat(20)}`;
const BUY_TO = `0x${"33".repeat(20)}`;
const TOKEN = `0x${"44".repeat(20)}`;

const env: RuntimeEnvironment = Object.freeze({
  CLOCKIN_LIVE: "true",
  ROBINHOOD_RPC_URL: "https://rpc.example/private",
  ROBINHOOD_WS_RPC_URL: "wss://rpc.example/private",
  CLOCKIN_POOL_ADDRESS: POOL,
  CLOCKIN_FEE_CALL_DATA: "0x12345678",
  CLOCKIN_LAUNCH_BLOCK: "10",
  CLOCKIN_LAUNCH_ID: "launch-1",
  CLOCKIN_WINDOW_STARTED_AT_MS: "2000000",
  CLOCKIN_PRIVATE_KEY: PRIVATE_KEY,
  CLOCKIN_EXPECTED_WALLET_ADDRESS: WALLET,
  CLOCKIN_BUY_TO: BUY_TO,
  CLOCKIN_TOKEN_ADDRESS: TOKEN,
  CLOCKIN_BUY_CALL_DATA: "0xabcdef12",
  CLOCKIN_BATCH_VALUE_WEI: "1000000000000000",
  CLOCKIN_GAS_LIMIT: "200000",
  CLOCKIN_MAX_FEE_PER_GAS_WEI: "10000000000",
  CLOCKIN_MAX_PRIORITY_FEE_PER_GAS_WEI: "1000000000",
});

function requester(options: { pendingNonce?: string; balance?: string } = {}): JsonRpcRequester {
  return {
    providerId: "preflight-rpc",
    async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      if (method === "eth_chainId") return "0x1237" as T;
      if (method === "eth_blockNumber") return "0x64" as T;
      if (method === "eth_getCode") return "0x6000" as T;
      if (method === "eth_getTransactionCount") {
        return (params[1] === "pending" ? (options.pendingNonce ?? "0x7") : "0x7") as T;
      }
      if (method === "eth_getBalance") {
        return (options.balance ?? "0x16345785d8a0000") as T;
      }
      if (method === "eth_getBlockByNumber") {
        return { baseFeePerGas: "0x3b9aca00" } as T;
      }
      if (method === "eth_call") {
        const call = params[0] as { readonly to: string };
        return (call.to.toLowerCase() === TOKEN.toLowerCase() ? "0x2a" : "0x0fa0") as T;
      }
      throw new Error(`unexpected RPC method ${method}`);
    },
  };
}

test("preflight binds chain, code, clean nonce, funds, fee state, and EIP-1559 headroom", async () => {
  const result = await runLivePreflight(requester(), loadLiveRuntimeConfig(env), () => 1_999_000);

  assert.equal(result.identity.chainId, 4_663n);
  assert.equal(result.latestNonce, 7n);
  assert.equal(result.pendingNonce, 7n);
  assert.equal(result.tokenBalanceBefore, 42n);
  assert.equal(result.observedFeeBps, 4_000);
  assert.equal(result.baseFeePerGasWei, 1_000_000_000n);
  assert.equal(result.requiredWorstCaseWei, 30_000_000_000_000_000n);
});

test("preflight refuses an already-busy wallet and insufficient reserved balance", async () => {
  const config = loadLiveRuntimeConfig(env);
  await assert.rejects(
    runLivePreflight(requester({ pendingNonce: "0x8" }), config, () => 1_999_000),
    /pending transactions/,
  );
  await assert.rejects(
    runLivePreflight(requester({ balance: "0x1" }), config, () => 1_999_000),
    /worst-case reservation/,
  );
});

test("preflight refuses an expired live window", async () => {
  await assert.rejects(
    runLivePreflight(requester(), loadLiveRuntimeConfig(env), () => 2_120_001),
    /already expired/,
  );
});
