import assert from "node:assert/strict";
import test from "node:test";

import { loadObservationRuntimeConfig, type RuntimeEnvironment } from "../src/index.js";

const baseEnv: RuntimeEnvironment = Object.freeze({
  CLOCKIN_POOL_ADDRESS: `0x${"12".repeat(20)}`,
  CLOCKIN_FEE_CALL_DATA: "0x12345678",
  CLOCKIN_LAUNCH_BLOCK: "1000",
  CLOCKIN_LAUNCH_ID: "clockin-mainnet-launch",
  CLOCKIN_WINDOW_STARTED_AT_MS: "2000000",
});

test("loads the confirmed 10x5U defaults without reading a secret file", () => {
  const config = loadObservationRuntimeConfig(baseEnv);

  assert.equal(config.plan.startFeeBps, 4_000);
  assert.equal(config.plan.floorFeeBps, 100);
  assert.equal(config.plan.batchCount, 10);
  assert.equal(config.plan.grossUsdMicrosPerBatch, 5_000_000n);
  assert.equal(config.plan.windowDurationMs, 120_000);
  assert.equal(config.pollIntervalMs, 250);
  assert.equal(config.wsRpcUrl, null);
  assert.deepEqual(config.pool.externalBuyRule, { kind: "block_after", launchBlock: 1_000n });
});

test("loads an optional authenticated WSS wake-up endpoint", () => {
  const config = loadObservationRuntimeConfig({
    ...baseEnv,
    ROBINHOOD_WS_RPC_URL: "wss://provider.example/private-path",
  });

  assert.equal(config.wsRpcUrl, "wss://provider.example/private-path");
});

test("loads a final ABI boolean call when it is the sole activation rule", () => {
  const config = loadObservationRuntimeConfig({
    ...baseEnv,
    CLOCKIN_LAUNCH_BLOCK: undefined,
    CLOCKIN_BUY_ALLOWED_CALL_DATA: "0xabcdef12",
  });

  assert.deepEqual(config.pool.externalBuyRule, {
    kind: "boolean_call",
    callData: "0xabcdef12",
  });
});

test("rejects ambiguous external-buy activation rules", () => {
  assert.throws(
    () =>
      loadObservationRuntimeConfig({
        ...baseEnv,
        CLOCKIN_BUY_ALLOWED_CALL_DATA: "0xabcdef12",
      }),
    /exactly one/,
  );
});

test("requires an explicit external-buy activation rule", () => {
  const env = { ...baseEnv };
  delete env.CLOCKIN_LAUNCH_BLOCK;

  assert.throws(() => loadObservationRuntimeConfig(env), /CLOCKIN_BUY_ALLOWED_CALL_DATA/);
});
