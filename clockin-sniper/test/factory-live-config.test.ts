import assert from "node:assert/strict";
import test from "node:test";

import { Wallet } from "ethers";

import { loadFactoryLiveRuntimeConfig, type RuntimeEnvironment } from "../src/index.js";

const PRIVATE_KEY = `0x${"11".repeat(32)}`;
const WALLET = new Wallet(PRIVATE_KEY).address;
const baseEnv: RuntimeEnvironment = Object.freeze({
  CLOCKIN_LIVE: "true",
  ROBINHOOD_RPC_URL: "https://rpc.example/private",
  ROBINHOOD_WS_RPC_URL: "wss://rpc.example/private",
  CLOCKIN_PRIVATE_KEY: PRIVATE_KEY,
  CLOCKIN_EXPECTED_WALLET_ADDRESS: WALLET,
  CLOCKIN_LAUNCH_ID: "clockin-mainnet-launch",
  CLOCKIN_FACTORY_ADDRESS: `0x${"22".repeat(20)}`,
  CLOCKIN_FACTORY_RUNTIME_CODE_HASH: `0x${"33".repeat(32)}`,
  CLOCKIN_BATCH_VALUE_WEI: "1000000000000000",
  CLOCKIN_GAS_LIMIT: "250000",
  CLOCKIN_MAX_FEE_PER_GAS_WEI: "10000000000",
  CLOCKIN_MAX_PRIORITY_FEE_PER_GAS_WEI: "1000000000",
});

test("loads Factory-first production config without requiring a pre-known CA or pool", () => {
  const config = loadFactoryLiveRuntimeConfig(baseEnv);
  assert.equal(config.identityPolicy.expectedName, "ClockIn");
  assert.equal(config.identityPolicy.expectedSymbol, "CLOCKIN");
  assert.equal(config.identityPolicy.requiredTokenSuffix, "666666");
  assert.equal(config.batchCount, 10);
  assert.equal(config.grossUsdMicrosPerBatch, 5_000_000n);
  assert.equal(config.expectedFloorFeeBps, 100);
  assert.equal(config.maxInitialFeeBps, 4_000);
  assert.equal(config.chainAuthorizedTrancheCount, 1);
  assert.equal(config.minTokensOut, 1n);
  assert.equal(config.officialCaUrl, "https://clockin.win/");
  assert.equal(config.officialCaFilePath, "runtime/official-clockin-ca.txt");
  assert.equal(config.directSequencerUrl, "https://sequencer.mainnet.chain.robinhood.com");
});

test("allows explicitly disabling the direct Sequencer and rejects lookalike hosts", () => {
  assert.equal(
    loadFactoryLiveRuntimeConfig({
      ...baseEnv,
      ROBINHOOD_DIRECT_SEQUENCER_URL: "",
    }).directSequencerUrl,
    undefined,
  );
  assert.throws(
    () =>
      loadFactoryLiveRuntimeConfig({
        ...baseEnv,
        ROBINHOOD_DIRECT_SEQUENCER_URL:
          "https://sequencer.mainnet.chain.robinhood.com.attacker.example",
      }),
    /official Robinhood mainnet HTTPS endpoint/,
  );
});

test("always retains the canonical RPC in the standard broadcast fanout", () => {
  const config = loadFactoryLiveRuntimeConfig({
    ...baseEnv,
    ROBINHOOD_BROADCAST_RPC_URLS: "https://secondary.example/rpc",
  });
  assert.deepEqual(config.broadcastRpcUrls, [
    "https://rpc.example/private",
    "https://secondary.example/rpc",
  ]);
  assert.throws(
    () =>
      loadFactoryLiveRuntimeConfig({
        ...baseEnv,
        ROBINHOOD_BROADCAST_RPC_URLS: "https://sequencer.mainnet.chain.robinhood.com",
      }),
    /ROBINHOOD_DIRECT_SEQUENCER_URL/,
  );
});

test("rejects disabling live mode, Factory code-hash omission, and capital-policy drift", () => {
  assert.throws(
    () => loadFactoryLiveRuntimeConfig({ ...baseEnv, CLOCKIN_LIVE: "false" }),
    /CLOCKIN_LIVE=true/,
  );
  assert.throws(
    () =>
      loadFactoryLiveRuntimeConfig({
        ...baseEnv,
        CLOCKIN_FACTORY_RUNTIME_CODE_HASH: undefined,
      }),
    /CLOCKIN_FACTORY_RUNTIME_CODE_HASH is required/,
  );
  assert.throws(
    () => loadFactoryLiveRuntimeConfig({ ...baseEnv, CLOCKIN_BATCH_COUNT: "9" }),
    /fixed at 10 x 5U/,
  );
  assert.throws(
    () =>
      loadFactoryLiveRuntimeConfig({
        ...baseEnv,
        CLOCKIN_CHAIN_AUTHORIZED_TRANCHES: "10",
      }),
    /only tranche one chain-authorized/,
  );
});
