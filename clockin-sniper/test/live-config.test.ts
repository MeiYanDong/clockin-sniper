import assert from "node:assert/strict";
import test from "node:test";

import { Wallet } from "ethers";

import { loadLiveRuntimeConfig, type RuntimeEnvironment } from "../src/index.js";

const PRIVATE_KEY = `0x${"11".repeat(32)}`;
const WALLET_ADDRESS = new Wallet(PRIVATE_KEY).address;

const baseLiveEnv: RuntimeEnvironment = Object.freeze({
  CLOCKIN_LIVE: "true",
  ROBINHOOD_RPC_URL: "https://rpc.example/private",
  ROBINHOOD_WS_RPC_URL: "wss://rpc.example/private",
  CLOCKIN_POOL_ADDRESS: `0x${"22".repeat(20)}`,
  CLOCKIN_FEE_CALL_DATA: "0x12345678",
  CLOCKIN_LAUNCH_BLOCK: "1000",
  CLOCKIN_LAUNCH_ID: "clockin-mainnet-launch",
  CLOCKIN_WINDOW_STARTED_AT_MS: "2000000",
  CLOCKIN_PRIVATE_KEY: PRIVATE_KEY,
  CLOCKIN_EXPECTED_WALLET_ADDRESS: WALLET_ADDRESS,
  CLOCKIN_BUY_TO: `0x${"33".repeat(20)}`,
  CLOCKIN_TOKEN_ADDRESS: `0x${"44".repeat(20)}`,
  CLOCKIN_BUY_CALL_DATA: "0xabcdef12",
  CLOCKIN_BATCH_VALUE_WEI: "1000000000000000",
  CLOCKIN_GAS_LIMIT: "200000",
  CLOCKIN_MAX_FEE_PER_GAS_WEI: "10000000000",
  CLOCKIN_MAX_PRIORITY_FEE_PER_GAS_WEI: "1000000000",
});

test("loads an explicitly armed fixed 10x5U live configuration", () => {
  const config = loadLiveRuntimeConfig({
    ...baseLiveEnv,
    ROBINHOOD_BROADCAST_RPC_URLS:
      "https://one.example/key, https://two.example/key, https://one.example/key",
  });

  assert.equal(config.plan.batchCount, 10);
  assert.equal(config.plan.grossUsdMicrosPerBatch, 5_000_000n);
  assert.equal(config.plan.windowDurationMs, 120_000);
  assert.equal(config.plan.startFeeBps, 4_000);
  assert.equal(config.plan.floorFeeBps, 100);
  assert.equal(config.beneficiaryAddress, WALLET_ADDRESS);
  assert.deepEqual(config.broadcastRpcUrls, ["https://one.example/key", "https://two.example/key"]);
});

test("refuses to load unless real-funds mode is explicitly armed", () => {
  assert.throws(
    () => loadLiveRuntimeConfig({ ...baseLiveEnv, CLOCKIN_LIVE: "false" }),
    /CLOCKIN_LIVE=true/,
  );
});

test("refuses strategy drift from the agreed 10x5U 40%-to-1% pool-fee policy", () => {
  assert.throws(
    () => loadLiveRuntimeConfig({ ...baseLiveEnv, CLOCKIN_BATCH_COUNT: "9" }),
    /fixed at 10 batches x 5U/,
  );
  assert.throws(
    () => loadLiveRuntimeConfig({ ...baseLiveEnv, CLOCKIN_FLOOR_FEE_BPS: "0" }),
    /fixed at 10 batches x 5U/,
  );
});

test("validates private-key shape and receipt timing without logging secrets", () => {
  assert.throws(
    () => loadLiveRuntimeConfig({ ...baseLiveEnv, CLOCKIN_PRIVATE_KEY: "0x11" }),
    /exactly 32 bytes/,
  );
  assert.throws(
    () =>
      loadLiveRuntimeConfig({
        ...baseLiveEnv,
        CLOCKIN_RECEIPT_POLL_MS: "1000",
        CLOCKIN_RECEIPT_TIMEOUT_MS: "500",
      }),
    /must not exceed receipt timeout/,
  );
});
