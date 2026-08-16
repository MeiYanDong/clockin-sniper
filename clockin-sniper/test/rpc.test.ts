import assert from "node:assert/strict";
import test from "node:test";

import {
  HttpJsonRpcClient,
  JsonRpcRequestError,
  verifyRobinhoodMainnet,
  verifyRobinhoodSequencerWriteEndpoint,
} from "../src/index.js";

test("HTTP JSON-RPC client sends a standard request without exposing its URL", async () => {
  let requestBody: unknown;
  const fetchFn: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new HttpJsonRpcClient({
    providerId: "mock-rpc",
    url: "https://secret-provider.example/key",
    fetchFn,
  });

  assert.equal(await client.request<string>("eth_blockNumber"), "0x123");
  assert.deepEqual(requestBody, {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_blockNumber",
    params: [],
  });
});

test("HTTP JSON-RPC client preserves structured RPC errors", async () => {
  const fetchFn: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32_000, message: "already known" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const client = new HttpJsonRpcClient({
    providerId: "mock-rpc",
    url: "https://provider.example",
    fetchFn,
  });

  await assert.rejects(
    client.request("eth_sendRawTransaction", ["0x01"]),
    (error: unknown) =>
      error instanceof JsonRpcRequestError &&
      error.code === -32_000 &&
      error.message.includes("already known"),
  );
});

test("verifies Robinhood mainnet chain identity and current block", async () => {
  const requester = {
    providerId: "mock-robinhood",
    async request<T>(method: string): Promise<T> {
      if (method === "eth_chainId") return "0x1237" as T;
      if (method === "eth_blockNumber") return "0x2a" as T;
      throw new Error(`unexpected method ${method}`);
    },
  };

  const identity = await verifyRobinhoodMainnet(requester);
  assert.equal(identity.chainId, 4_663n);
  assert.equal(identity.blockNumber, 42n);
});

test("rejects an RPC connected to the wrong chain", async () => {
  const requester = {
    providerId: "wrong-chain",
    async request<T>(method: string): Promise<T> {
      return (method === "eth_chainId" ? "0x1" : "0x2a") as T;
    },
  };

  await assert.rejects(verifyRobinhoodMainnet(requester), /expected Robinhood mainnet 4663/);
});

test("verifies the write-only Sequencer without sending a signed transaction", async () => {
  let observedMethod: string | null = null;
  let observedParams: readonly unknown[] | null = null;
  const requester = {
    providerId: "mock-direct-sequencer",
    async request<T>(method: string, params: readonly unknown[]): Promise<T> {
      observedMethod = method;
      observedParams = params;
      throw new JsonRpcRequestError({
        providerId: this.providerId,
        method,
        code: -32_000,
        message: "typed transaction too short",
      });
    },
  };

  await verifyRobinhoodSequencerWriteEndpoint(requester);
  assert.equal(observedMethod, "eth_sendRawTransaction");
  assert.deepEqual(observedParams, ["0x"]);
});
