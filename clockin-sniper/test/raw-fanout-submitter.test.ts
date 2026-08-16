import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryPreparedTransactionSource,
  JsonRpcRequestError,
  MultiRpcRawTransactionSubmitter,
  type Hex,
  type JsonRpcRequester,
  type TrancheIntent,
} from "../src/index.js";

const RAW_TX = "0x01020304" as Hex;
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;

const intent: TrancheIntent = Object.freeze({
  intentId: "clockin:tranche:1",
  launchId: "clockin",
  trancheNumber: 1,
  attemptNumber: 1,
  targetFeeBps: 4_000,
  observedFeeBps: 4_000,
  referenceOffsetMs: 0,
  earliestDispatchOffsetMs: 0,
  grossUsdMicros: 5_000_000n,
  observedAtMs: 1_000,
  blockNumber: 100n,
  expiresAtMs: 121_000,
});

class BroadcastRequester implements JsonRpcRequester {
  readonly providerId: string;
  readonly rawTransactions: string[] = [];
  readonly #handler: () => string | Promise<string>;

  constructor(providerId: string, handler: () => string | Promise<string>) {
    this.providerId = providerId;
    this.#handler = handler;
  }

  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    assert.equal(method, "eth_sendRawTransaction");
    this.rawTransactions.push(String(params[0]));
    return (await this.#handler()) as T;
  }
}

function source(expectedTxHash: Hex | undefined = TX_HASH): InMemoryPreparedTransactionSource {
  const prepared =
    expectedTxHash === undefined
      ? { rawTransaction: RAW_TX }
      : { rawTransaction: RAW_TX, expectedTxHash };
  return new InMemoryPreparedTransactionSource([[intent.intentId, prepared]]);
}

test("fans out the exact same raw transaction and returns the first acceptance", async () => {
  const slow = new BroadcastRequester("slow", async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    return TX_HASH;
  });
  const fast = new BroadcastRequester("fast", () => TX_HASH);
  const submitter = new MultiRpcRawTransactionSubmitter([slow, fast], source());

  const result = await submitter.submit(intent);
  assert.equal(result.state, "accepted");
  assert.equal(result.txHash, TX_HASH);
  assert.deepEqual(slow.rawTransactions, [RAW_TX]);
  assert.deepEqual(fast.rawTransactions, [RAW_TX]);
});

test("treats already-known as successful propagation", async () => {
  const requester = new BroadcastRequester("known", () => {
    throw new JsonRpcRequestError({
      providerId: "known",
      method: "eth_sendRawTransaction",
      code: -32_000,
      message: "already known",
    });
  });
  const submitter = new MultiRpcRawTransactionSubmitter([requester], source());

  const result = await submitter.submit(intent);
  assert.equal(result.state, "known");
  assert.equal(result.txHash, TX_HASH);
});

test("returns unknown when every route is ambiguous", async () => {
  const requesters = ["timeout", "nonce"].map(
    (providerId) =>
      new BroadcastRequester(providerId, () => {
        throw new Error(providerId === "timeout" ? "request timeout" : "nonce too low");
      }),
  );
  const submitter = new MultiRpcRawTransactionSubmitter(requesters, source());

  const result = await submitter.submit(intent);
  assert.equal(result.state, "unknown");
  assert.equal(result.txHash, TX_HASH);
});

test("treats provider throttling and server errors as unknown, not deterministic rejection", async () => {
  const requesters = ["throttled", "server"].map(
    (providerId) =>
      new BroadcastRequester(providerId, () => {
        throw new Error(providerId === "throttled" ? "HTTP 429" : "HTTP 503");
      }),
  );
  const submitter = new MultiRpcRawTransactionSubmitter(requesters, source());

  assert.equal((await submitter.submit(intent)).state, "unknown");
});

test("throws only when all providers deterministically reject the transaction", async () => {
  const requesters = ["invalid", "funds"].map(
    (providerId) =>
      new BroadcastRequester(providerId, () => {
        throw new Error(providerId === "invalid" ? "invalid sender" : "insufficient funds");
      }),
  );
  const submitter = new MultiRpcRawTransactionSubmitter(requesters, source());

  await assert.rejects(submitter.submit(intent), AggregateError);
});

test("rejects a provider hash that does not match the signed transaction", async () => {
  const wrongHash = `0x${"cd".repeat(32)}`;
  const requester = new BroadcastRequester("wrong-hash", () => wrongHash);
  const submitter = new MultiRpcRawTransactionSubmitter([requester], source());

  await assert.rejects(submitter.submit(intent), /all RPCs rejected/);
});
