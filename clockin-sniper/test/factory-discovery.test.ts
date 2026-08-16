import assert from "node:assert/strict";
import test from "node:test";

import { Interface } from "ethers";

import {
  discoverClockInLaunch,
  runtimeCodeHash,
  type DiscoveryEvent,
  type Hex,
  type JsonRpcRequester,
  type RawRpcContractLog,
} from "../src/index.js";

const FACTORY = `0x${"10".repeat(20)}` as Hex;
const CREATOR = `0x${"20".repeat(20)}` as Hex;
const POOL = `0x${"30".repeat(20)}` as Hex;
const TOKEN = `0x${"11".repeat(17)}666666` as Hex;
const factoryAbi = new Interface([
  "event TokenLaunched(address indexed creator,address indexed memeToken,address indexed pool,string name,string symbol,string metadataURI,bytes32 imageHash)",
]);

function rawLog(
  name: string,
  symbol: string,
  token: Hex,
  transactionByte: string,
  logIndex: number,
): RawRpcContractLog {
  const encoded = factoryAbi.encodeEventLog("TokenLaunched", [
    CREATOR,
    token,
    POOL,
    name,
    symbol,
    "https://clockin.win/metadata.json",
    `0x${"ab".repeat(32)}`,
  ]);
  return {
    address: FACTORY,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: "0x65",
    transactionHash: `0x${transactionByte.repeat(32)}`,
    logIndex: `0x${logIndex.toString(16)}`,
    removed: false,
  };
}

test("subscribes before boundary backfill, rejects same-Factory spoof names, and freezes first match", async () => {
  const expectedFactoryCodeHash = runtimeCodeHash("0x6000");
  const events: DiscoveryEvent[] = [];
  const requester: JsonRpcRequester = {
    providerId: "factory-http",
    async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      if (method === "eth_getCode") return "0x6000" as T;
      if (method === "eth_blockNumber") return "0x65" as T;
      if (method === "eth_getLogs") {
        const filter = params[0] as { readonly fromBlock: string; readonly toBlock: string };
        assert.equal(filter.fromBlock, "0x64");
        assert.equal(filter.toBlock, "0x65");
        return [
          rawLog("ClockIn Scam", "CLOCKIN", `0x${"44".repeat(20)}`, "55", 0),
          rawLog("ClockIn", "CLOCKIN", TOKEN, "66", 1),
        ] as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  let subscribed = false;
  const candidate = await discoverClockInLaunch({
    requester,
    wsRpcUrl: "wss://provider.example/private",
    providerId: "factory-wss",
    identityPolicy: {
      factoryAddress: FACTORY,
      expectedName: "ClockIn",
      expectedSymbol: "CLOCKIN",
      metadataIncludes: "clockin.win",
      requiredTokenSuffix: "666666",
    },
    expectedFactoryCodeHash,
    startBlock: 100n,
    logsClientFactory: async () => {
      subscribed = true;
      return {
        done: new Promise<void>(() => undefined),
        close() {},
      };
    },
    onEvent(event) {
      events.push(event);
    },
  });

  assert.equal(subscribed, true);
  assert.equal(candidate.tokenAddress, TOKEN);
  assert.equal(candidate.poolAddress, POOL);
  assert.equal(candidate.blockNumber, 101n);
  assert.equal(candidate.source, "backfill");
  assert.ok(events.some((event) => event.kind === "candidate_rejected"));
  assert.ok(events.some((event) => event.kind === "backfill"));
});

test("fails closed when the configured Factory runtime hash drifts", async () => {
  const requester: JsonRpcRequester = {
    providerId: "factory-http",
    async request<T>(method: string): Promise<T> {
      if (method === "eth_getCode") return "0x6001" as T;
      throw new Error(`unexpected method ${method}`);
    },
  };
  await assert.rejects(
    discoverClockInLaunch({
      requester,
      wsRpcUrl: "wss://provider.example/private",
      providerId: "factory-wss",
      identityPolicy: {
        factoryAddress: FACTORY,
        expectedName: "ClockIn",
        expectedSymbol: "CLOCKIN",
      },
      expectedFactoryCodeHash: runtimeCodeHash("0x6000"),
    }),
    /Factory runtime code hash mismatch/,
  );
});
