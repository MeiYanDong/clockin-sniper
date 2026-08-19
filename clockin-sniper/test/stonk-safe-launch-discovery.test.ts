import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Interface } from "ethers";
import type { Hex, JsonRpcRequester } from "../src/rpc/types.js";
import type {
  ContractLogSubscription,
  RawRpcContractLog,
  RpcContractLog,
} from "../src/rpc/websocket-logs.js";
import {
  CLOCKIN_APPROVED_LAUNCH_CREATOR,
  CLOCKIN_EXPECTED_TOKEN_NAME,
  CLOCKIN_EXPECTED_TOKEN_SYMBOL,
  decodeStonkSafeLaunchQuotedCreated,
  discoverStonkSafeLaunchClockIn,
  STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
  STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
  STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
} from "../src/v2-index.js";

const quotedInterface = new Interface([
  "event LaunchCreated(uint256 indexed id,address indexed token,address indexed creator,bool externalToken)",
  "event LaunchArmed(uint256 indexed id,uint256 supply,uint256 vEth0,uint64 ethUsd8,uint64 deadline)",
]);
const metadataInterface = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
const TOKEN = `0x${"11".repeat(20)}` as Hex;
const TOKEN_TWO = `0x${"22".repeat(20)}` as Hex;
const WRONG_CREATOR = `0x${"33".repeat(20)}` as Hex;
const TX_CREATED = `0x${"44".repeat(32)}` as Hex;
const TX_ARMED = `0x${"55".repeat(32)}` as Hex;

function eventLog(
  eventName: "LaunchCreated" | "LaunchArmed",
  values: readonly unknown[],
  options: {
    blockNumber?: bigint;
    transactionHash?: Hex;
    logIndex?: bigint;
    removed?: boolean;
    address?: Hex;
  } = {},
): RpcContractLog {
  const encoded = quotedInterface.encodeEventLog(eventName, [...values]);
  return Object.freeze({
    address: options.address ?? STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
    topics: encoded.topics as readonly Hex[],
    data: encoded.data as Hex,
    blockNumber: options.blockNumber ?? 101n,
    transactionHash:
      options.transactionHash ?? (eventName === "LaunchCreated" ? TX_CREATED : TX_ARMED),
    logIndex: options.logIndex ?? (eventName === "LaunchCreated" ? 1n : 2n),
    removed: options.removed ?? false,
  });
}

function createdLog(
  id = 9n,
  token = TOKEN,
  creator: Hex = CLOCKIN_APPROVED_LAUNCH_CREATOR.toLowerCase() as Hex,
  options: Parameters<typeof eventLog>[2] = {},
): RpcContractLog {
  return eventLog("LaunchCreated", [id, token, creator, false], options);
}

function armedLog(id = 9n, options: Parameters<typeof eventLog>[2] = {}): RpcContractLog {
  return eventLog("LaunchArmed", [id, 1_000_000n, 25_000n, 345_678_900_000n, 9_999_999n], options);
}

function raw(log: RpcContractLog): RawRpcContractLog {
  return Object.freeze({
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: `0x${log.blockNumber.toString(16)}`,
    transactionHash: log.transactionHash,
    logIndex: `0x${log.logIndex.toString(16)}`,
    removed: log.removed,
  });
}

function neverEndingSubscription(): ContractLogSubscription {
  return Object.freeze({
    done: new Promise<void>(() => {}),
    close() {},
  });
}

function fixtureRequester(
  options: {
    readonly heads?: readonly bigint[];
    readonly backfills?: readonly (readonly RawRpcContractLog[])[];
    readonly metadataByToken?: Readonly<Record<string, readonly [string, string]>>;
    readonly metadataFailures?: number;
    readonly metadataFailureMessage?: string;
    readonly getLogs?: (
      params: readonly unknown[],
    ) => Promise<readonly RawRpcContractLog[]> | readonly RawRpcContractLog[];
    readonly onCall?: (method: string, params: readonly unknown[]) => void;
  } = {},
): JsonRpcRequester {
  let headIndex = 0;
  let backfillIndex = 0;
  let remainingMetadataFailures = options.metadataFailures ?? 0;
  return Object.freeze({
    providerId: "safe-launch-discovery-fixture",
    async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      options.onCall?.(method, params);
      if (method === "eth_blockNumber") {
        const heads = options.heads ?? [100n];
        const head = heads[Math.min(headIndex, heads.length - 1)] ?? 100n;
        headIndex += 1;
        return `0x${head.toString(16)}` as T;
      }
      if (method === "eth_getLogs") {
        if (options.getLogs !== undefined) return (await options.getLogs(params)) as T;
        const entries = options.backfills ?? [[]];
        const logs = entries[Math.min(backfillIndex, entries.length - 1)] ?? [];
        backfillIndex += 1;
        return logs as T;
      }
      if (method === "eth_call") {
        if (remainingMetadataFailures > 0) {
          remainingMetadataFailures -= 1;
          throw new Error(options.metadataFailureMessage ?? "temporary metadata transport failure");
        }
        const call = params[0] as { readonly to: string; readonly data: string };
        const parsed = metadataInterface.parseTransaction({ data: call.data });
        if (parsed === null || (parsed.name !== "name" && parsed.name !== "symbol")) {
          throw new Error("unexpected metadata call");
        }
        const pair = options.metadataByToken?.[call.to.toLowerCase()] ?? [
          CLOCKIN_EXPECTED_TOKEN_NAME,
          CLOCKIN_EXPECTED_TOKEN_SYMBOL,
        ];
        return metadataInterface.encodeFunctionResult(parsed.name, [
          parsed.name === "name" ? pair[0] : pair[1],
        ]) as T;
      }
      throw new Error(`unexpected RPC ${method}`);
    },
  });
}

function liveSubscriptions() {
  const callbacks = new Map<string, (log: RpcContractLog) => void>();
  return Object.freeze({
    callbacks,
    factory: async (
      topic0: Hex,
      onLog: (log: RpcContractLog) => void,
    ): Promise<ContractLogSubscription> => {
      callbacks.set(topic0.toLowerCase(), onLog);
      return neverEndingSubscription();
    },
    emit(log: RpcContractLog) {
      const callback = callbacks.get(log.topics[0]?.toLowerCase() ?? "");
      if (callback === undefined) throw new Error("event callback is not subscribed");
      callback(log);
    },
  });
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("ClockIn quoted Safe Launch discovery", () => {
  it("binds the current WETH quoted pad and verified event topics", () => {
    assert.equal(
      STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
      "0xABEa69101B2a19347A34339F24cAD8b9523E9c29",
    );
    assert.equal(
      STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
      "0xa4d3b2dc54656491295ce21a0b888cd8df38e69113e44371344da5088e480a43",
    );
    assert.equal(
      STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
      "0x617dff9af409b81e92edd8d62fb192f25509657b96d203585e3e6b605d4dea26",
    );
    assert.equal(
      decodeStonkSafeLaunchQuotedCreated(createdLog()).creatorAddress.toLowerCase(),
      CLOCKIN_APPROVED_LAUNCH_CREATOR.toLowerCase(),
    );
  });

  it("keeps an exact-block metadata candidate pending until the same id is armed", async () => {
    const live = liveSubscriptions();
    const exactBlocks: unknown[] = [];
    const discovery = discoverStonkSafeLaunchClockIn({
      requester: fixtureRequester({
        onCall(method, params) {
          if (method === "eth_call") exactBlocks.push(params[1]);
        },
      }),
      wssUrl: "wss://fixture.invalid",
      logsClientFactory: live.factory,
    });
    await nextTurn();

    live.emit(createdLog(9n));
    live.emit(armedLog(10n, { transactionHash: `0x${"66".repeat(32)}` as Hex }));
    let settled = false;
    discovery.finally(() => {
      settled = true;
    });
    await nextTurn();
    assert.equal(settled, false);

    live.emit(armedLog(9n));
    const result = await discovery;
    assert.equal(result.created.id, 9n);
    assert.equal(result.armed.id, 9n);
    assert.equal(
      result.created.creatorAddress.toLowerCase(),
      CLOCKIN_APPROVED_LAUNCH_CREATOR.toLowerCase(),
    );
    assert.deepEqual(result.metadata, {
      name: CLOCKIN_EXPECTED_TOKEN_NAME,
      symbol: CLOCKIN_EXPECTED_TOKEN_SYMBOL,
      blockNumber: 101n,
    });
    assert.deepEqual(exactBlocks, ["0x65", "0x65"]);
    assert.equal(result.createdSource, "WSS");
    assert.equal(result.armedSource, "WSS");
  });

  it("binds paid discovery to the exact public handoff and ignores later matching-name launches", async () => {
    const live = liveSubscriptions();
    const target = createdLog(9n, TOKEN, CLOCKIN_APPROVED_LAUNCH_CREATOR.toLowerCase() as Hex, {
      blockNumber: 101n,
      transactionHash: TX_CREATED,
      logIndex: 1n,
    });
    const discovery = discoverStonkSafeLaunchClockIn({
      requester: fixtureRequester(),
      wssUrl: "wss://fixture.invalid",
      logsClientFactory: live.factory,
      startBlock: 101n,
      expectedCreated: {
        factoryAddress: STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
        launchId: "9",
        tokenAddress: TOKEN,
        creatorAddress: CLOCKIN_APPROVED_LAUNCH_CREATOR,
        externalToken: false,
        blockNumber: "101",
        transactionHash: TX_CREATED,
        logIndex: "1",
      },
    });
    await nextTurn();
    live.emit(
      createdLog(10n, TOKEN_TWO, CLOCKIN_APPROVED_LAUNCH_CREATOR.toLowerCase() as Hex, {
        blockNumber: 102n,
        transactionHash: `0x${"77".repeat(32)}` as Hex,
        logIndex: 1n,
      }),
    );
    live.emit(target);
    live.emit(armedLog(10n, { blockNumber: 103n, transactionHash: `0x${"78".repeat(32)}` as Hex }));
    await nextTurn();
    live.emit(armedLog(9n, { blockNumber: 104n }));
    const result = await discovery;
    assert.equal(result.created.id, 9n);
    assert.equal(result.created.transactionHash, TX_CREATED);
    assert.equal(result.created.logIndex, 1n);
    assert.equal(result.armed.id, 9n);
  });

  it("retries transient exact-block metadata failures without rejecting or forgetting the CA", async () => {
    const live = liveSubscriptions();
    const events: string[] = [];
    const delays: number[] = [];
    const discovery = discoverStonkSafeLaunchClockIn({
      requester: fixtureRequester({
        metadataFailures: 1,
        metadataFailureMessage: "HTTP 429 archive state temporarily unavailable",
      }),
      wssUrl: "wss://fixture.invalid",
      logsClientFactory: live.factory,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      onEvent(event) {
        events.push(event.kind);
      },
    });
    await nextTurn();

    live.emit(createdLog());
    live.emit(armedLog());
    const result = await discovery;

    assert.equal(result.created.id, 9n);
    assert.deepEqual(delays, [100]);
    assert.equal(events.filter((kind) => kind === "METADATA_RETRY").length, 1);
    assert.equal(events.includes("CANDIDATE_REJECTED"), false);
  });

  it("rejects creator and metadata mismatches, then accepts a valid later launch", async () => {
    const live = liveSubscriptions();
    const events: string[] = [];
    const requester = fixtureRequester({
      metadataByToken: {
        [TOKEN_TWO.toLowerCase()]: ["Clock Out", "CLOCKOUT"],
      },
    });
    const discovery = discoverStonkSafeLaunchClockIn({
      requester,
      wssUrl: "wss://fixture.invalid",
      logsClientFactory: live.factory,
      onEvent(event) {
        events.push(event.kind);
      },
    });
    await nextTurn();
    live.emit(
      createdLog(7n, TOKEN, WRONG_CREATOR, { transactionHash: `0x${"70".repeat(32)}` as Hex }),
    );
    live.emit(
      createdLog(8n, TOKEN_TWO, CLOCKIN_APPROVED_LAUNCH_CREATOR.toLowerCase() as Hex, {
        transactionHash: `0x${"71".repeat(32)}` as Hex,
        logIndex: 2n,
      }),
    );
    live.emit(
      createdLog(9n, TOKEN, CLOCKIN_APPROVED_LAUNCH_CREATOR.toLowerCase() as Hex, {
        transactionHash: TX_CREATED,
        logIndex: 3n,
      }),
    );
    live.emit(armedLog(9n, { logIndex: 4n }));
    const result = await discovery;
    assert.equal(result.created.id, 9n);
    assert.equal(events.filter((kind) => kind === "CANDIDATE_REJECTED").length, 2);
    assert.equal(events.includes("CANDIDATE_BOUND"), true);
  });

  it("reconnects and backfills both event topics without waiting for X", async () => {
    let subscriptionCall = 0;
    const requester = fixtureRequester({
      heads: [100n, 100n, 102n],
      backfills: [[], [raw(createdLog()), raw(armedLog())]],
      onCall(method, params) {
        if (method !== "eth_getLogs") return;
        const filter = params[0] as {
          readonly address: string;
          readonly topics: readonly (readonly string[])[];
        };
        assert.equal(filter.address, STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS);
        assert.deepEqual(filter.topics[0], [
          STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
          STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
        ]);
      },
    });
    const reconnects: number[] = [];
    const result = await discoverStonkSafeLaunchClockIn({
      requester,
      wssUrl: "wss://fixture.invalid",
      logsClientFactory: async () => {
        subscriptionCall += 1;
        if (subscriptionCall <= 2) {
          return Object.freeze({ done: Promise.resolve(), close() {} });
        }
        return neverEndingSubscription();
      },
      sleep: async () => {},
      onEvent(event) {
        if (event.kind === "WSS_RECONNECT") reconnects.push(event.attempt);
      },
    });
    assert.deepEqual(reconnects, [1]);
    assert.equal(result.createdSource, "BACKFILL");
    assert.equal(result.armedSource, "BACKFILL");
    assert.equal(result.created.id, result.armed.id);
  });

  it("shrinks rejected getLogs ranges, keeps inclusive boundaries, and deduplicates logs", async () => {
    const requestedRanges: Array<readonly [bigint, bigint]> = [];
    const allLogs = [
      raw(
        createdLog(9n, TOKEN, CLOCKIN_APPROVED_LAUNCH_CREATOR.toLowerCase() as Hex, {
          blockNumber: 104n,
        }),
      ),
      raw(
        createdLog(9n, TOKEN, CLOCKIN_APPROVED_LAUNCH_CREATOR.toLowerCase() as Hex, {
          blockNumber: 104n,
        }),
      ),
      raw(armedLog(9n, { blockNumber: 105n })),
      raw(armedLog(9n, { blockNumber: 105n })),
    ];
    const requester = fixtureRequester({
      heads: [100n, 110n],
      getLogs(params) {
        const filter = params[0] as { readonly fromBlock: string; readonly toBlock: string };
        const fromBlock = BigInt(filter.fromBlock);
        const toBlock = BigInt(filter.toBlock);
        requestedRanges.push([fromBlock, toBlock]);
        if (toBlock - fromBlock + 1n > 2n) {
          throw new Error("provider rejects wide getLogs range");
        }
        return allLogs.filter((log) => {
          const blockNumber = BigInt(log.blockNumber as string);
          return blockNumber >= fromBlock && blockNumber <= toBlock;
        });
      },
    });

    const result = await discoverStonkSafeLaunchClockIn({
      requester,
      wssUrl: "wss://fixture.invalid",
      logsClientFactory: async () => neverEndingSubscription(),
      backfillChunkSize: 8n,
      sleep: async () => {},
    });

    assert.equal(result.created.id, 9n);
    assert.equal(result.armed.id, 9n);
    assert.equal(
      requestedRanges.some(([fromBlock, toBlock]) => fromBlock === 100n && toBlock === 107n),
      true,
    );
    assert.equal(
      requestedRanges.some(([fromBlock, toBlock]) => fromBlock <= 104n && toBlock >= 105n),
      true,
    );
    assert.equal(
      requestedRanges
        .filter(([fromBlock, toBlock]) => toBlock - fromBlock + 1n <= 2n)
        .some(([fromBlock, toBlock]) => fromBlock === 104n && toBlock === 105n),
      true,
    );
  });

  it("reconnects and backfills a created log after metadata retries are exhausted", async () => {
    let subscriptionCalls = 0;
    const reconnects: number[] = [];
    const requester = fixtureRequester({
      heads: [100n, 101n, 101n],
      metadataFailures: 4,
      backfills: [[], [raw(createdLog()), raw(armedLog())]],
    });
    const callbacks = new Map<string, (log: RpcContractLog) => void>();
    const discovery = discoverStonkSafeLaunchClockIn({
      requester,
      wssUrl: "wss://fixture.invalid",
      metadataAttemptsPerConnection: 2,
      logsClientFactory: async (topic0, onLog) => {
        subscriptionCalls += 1;
        callbacks.set(topic0.toLowerCase(), onLog);
        return neverEndingSubscription();
      },
      sleep: async () => {},
      onEvent(event) {
        if (event.kind === "WSS_RECONNECT") reconnects.push(event.attempt);
      },
    });
    await nextTurn();
    const createdCallback = callbacks.get(STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC.toLowerCase());
    assert.notEqual(createdCallback, undefined);
    createdCallback?.(createdLog());

    const result = await discovery;
    assert.equal(result.created.id, 9n);
    assert.equal(result.createdSource, "BACKFILL");
    assert.equal(result.armedSource, "BACKFILL");
    assert.equal(subscriptionCalls >= 4, true);
    assert.deepEqual(reconnects, [1]);
  });

  it("fails closed on a removed log and on a second matching candidate", async () => {
    const removedLive = liveSubscriptions();
    const removedDiscovery = discoverStonkSafeLaunchClockIn({
      requester: fixtureRequester(),
      wssUrl: "wss://fixture.invalid",
      logsClientFactory: removedLive.factory,
    });
    await nextTurn();
    removedLive.emit(
      createdLog(9n, TOKEN, CLOCKIN_APPROVED_LAUNCH_CREATOR.toLowerCase() as Hex, {
        removed: true,
      }),
    );
    await assert.rejects(removedDiscovery, /removed Safe Launch log/);

    const conflictLive = liveSubscriptions();
    const conflictDiscovery = discoverStonkSafeLaunchClockIn({
      requester: fixtureRequester(),
      wssUrl: "wss://fixture.invalid",
      logsClientFactory: conflictLive.factory,
    });
    await nextTurn();
    conflictLive.emit(createdLog(9n));
    conflictLive.emit(
      createdLog(10n, TOKEN_TWO, CLOCKIN_APPROVED_LAUNCH_CREATOR.toLowerCase() as Hex, {
        transactionHash: `0x${"77".repeat(32)}` as Hex,
        logIndex: 3n,
      }),
    );
    await assert.rejects(conflictDiscovery, /multiple distinct approved ClockIn/);
  });
});
