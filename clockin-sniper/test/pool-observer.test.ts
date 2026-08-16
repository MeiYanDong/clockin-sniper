import assert from "node:assert/strict";
import test from "node:test";

import {
  JsonRpcPoolObserver,
  RacingPoolObserver,
  type Hex,
  type JsonRpcRequester,
} from "../src/index.js";

const POOL = `0x${"11".repeat(20)}` as Hex;
const FEE_CALL = "0x12345678" as Hex;
const BUY_ALLOWED_CALL = "0x87654321" as Hex;

function abiWord(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

class MockRequester implements JsonRpcRequester {
  readonly providerId: string;
  readonly calls: { method: string; params: readonly unknown[] }[] = [];
  readonly #handler: (method: string, params: readonly unknown[]) => unknown | Promise<unknown>;

  constructor(
    providerId: string,
    handler: (method: string, params: readonly unknown[]) => unknown | Promise<unknown>,
  ) {
    this.providerId = providerId;
    this.#handler = handler;
  }

  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    this.calls.push({ method, params });
    return (await this.#handler(method, params)) as T;
  }
}

test("reads fee and external-buy state at one exact block", async () => {
  const requester = new MockRequester("pool-rpc", (method, params) => {
    if (method === "eth_blockNumber") return "0x64";
    if (method === "eth_call") {
      const call = params[0] as { data: string };
      return call.data === FEE_CALL ? abiWord(3_556n) : abiWord(1n);
    }
    throw new Error(`unexpected method ${method}`);
  });
  const observer = new JsonRpcPoolObserver(
    requester,
    {
      poolAddress: POOL,
      feeCallData: FEE_CALL,
      externalBuyRule: { kind: "boolean_call", callData: BUY_ALLOWED_CALL },
    },
    () => 123_456,
  );

  const observation = await observer.observe();
  assert.deepEqual(observation, {
    observedAtMs: 123_456,
    blockNumber: 100n,
    feeBps: 3_556,
    externalBuyAllowed: true,
  });
  const calls = requester.calls.filter((call) => call.method === "eth_call");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.params[1] === "0x64"));
});

test("reads a WSS-supplied block without asking HTTP for latest", async () => {
  const requester = new MockRequester("pool-rpc", (method, params) => {
    if (method === "eth_call") {
      assert.equal(params[1], "0x65");
      return abiWord(3_111n);
    }
    throw new Error(`unexpected method ${method}`);
  });
  const observer = new JsonRpcPoolObserver(
    requester,
    { poolAddress: POOL, feeCallData: FEE_CALL, externalBuyRule: { kind: "always" } },
    () => 123_457,
  );

  const observation = await observer.observeAt(101n);
  assert.equal(observation.blockNumber, 101n);
  assert.equal(observation.feeBps, 3_111);
  assert.ok(requester.calls.every((call) => call.method !== "eth_blockNumber"));
});

test("derives creator-only launch-block activation without another RPC call", async () => {
  let blockNumber = 500n;
  const requester = new MockRequester("pool-rpc", (method) => {
    if (method === "eth_blockNumber") return `0x${blockNumber.toString(16)}`;
    if (method === "eth_call") return abiWord(4_000n);
    throw new Error(`unexpected method ${method}`);
  });
  const observer = new JsonRpcPoolObserver(requester, {
    poolAddress: POOL,
    feeCallData: FEE_CALL,
    externalBuyRule: { kind: "block_after", launchBlock: 500n },
  });

  assert.equal((await observer.observe()).externalBuyAllowed, false);
  blockNumber = 501n;
  assert.equal((await observer.observe()).externalBuyAllowed, true);
});

test("rejects impossible contract fee values", async () => {
  const requester = new MockRequester("pool-rpc", (method) =>
    method === "eth_blockNumber" ? "0x1" : abiWord(10_001n),
  );
  const observer = new JsonRpcPoolObserver(requester, {
    poolAddress: POOL,
    feeCallData: FEE_CALL,
    externalBuyRule: { kind: "always" },
  });

  await assert.rejects(observer.observe(), /exceeds 10000 bps/);
});

test("races independent read providers and returns the first valid observation", async () => {
  const slow = new JsonRpcPoolObserver(
    new MockRequester("slow", async (method) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return method === "eth_blockNumber" ? "0x2" : abiWord(3_000n);
    }),
    { poolAddress: POOL, feeCallData: FEE_CALL, externalBuyRule: { kind: "always" } },
    () => 2,
  );
  const fast = new JsonRpcPoolObserver(
    new MockRequester("fast", (method) => (method === "eth_blockNumber" ? "0x3" : abiWord(2_000n))),
    { poolAddress: POOL, feeCallData: FEE_CALL, externalBuyRule: { kind: "always" } },
    () => 3,
  );

  const observation = await new RacingPoolObserver([slow, fast]).observe();
  assert.equal(observation.blockNumber, 3n);
  assert.equal(observation.feeBps, 2_000);
});
