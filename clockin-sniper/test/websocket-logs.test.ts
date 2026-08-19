import assert from "node:assert/strict";
import test from "node:test";

import {
  type Hex,
  type LogWebSocketFactory,
  type RpcContractLog,
  WebSocketContractLogsClient,
} from "../src/index.js";

type Listener = (event: { data?: unknown; code?: number }) => void;

class FakeWebSocket {
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Listener[]>();
  closed = false;

  addEventListener(type: string, listener: Listener): void {
    const values = this.#listeners.get(type) ?? [];
    values.push(listener);
    this.#listeners.set(type, values);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1_000): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", { code });
  }

  emit(type: string, event: { data?: unknown; code?: number } = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  emitJson(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }
}

const FACTORY = `0x${"10".repeat(20)}` as Hex;
const TOPIC = `0x${"20".repeat(32)}` as Hex;

function setup(options: { readonly address?: Hex } = { address: FACTORY }): {
  readonly socket: FakeWebSocket;
  readonly logs: RpcContractLog[];
  readonly client: WebSocketContractLogsClient;
} {
  const socket = new FakeWebSocket();
  const factory = (() => socket) as LogWebSocketFactory;
  const logs: RpcContractLog[] = [];
  return {
    socket,
    logs,
    client: new WebSocketContractLogsClient({
      providerId: "factory-wss",
      url: "wss://provider.example/private",
      ...(options.address === undefined ? {} : { address: options.address }),
      topic0: TOPIC,
      webSocketFactory: factory,
    }),
  };
}

test("verifies chain and subscribes to the exact Factory + TokenLaunched topic", async () => {
  const { socket, logs, client } = setup();
  const ready = client.subscribe((log) => logs.push(log));
  socket.emit("open");
  socket.emitJson({ jsonrpc: "2.0", id: 1, result: "0x1237" });
  const subscribeRequest = JSON.parse(socket.sent[1] ?? "{}") as {
    readonly params?: readonly unknown[];
  };
  assert.deepEqual(subscribeRequest.params, ["logs", { address: FACTORY, topics: [TOPIC] }]);
  socket.emitJson({ jsonrpc: "2.0", id: 2, result: "0xsub" });
  const subscription = await ready;
  socket.emitJson({
    jsonrpc: "2.0",
    method: "eth_subscription",
    params: {
      subscription: "0xsub",
      result: {
        address: FACTORY,
        topics: [TOPIC],
        data: "0x",
        blockNumber: "0x64",
        transactionHash: `0x${"30".repeat(32)}`,
        logIndex: "0x2",
        removed: false,
      },
    },
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.blockNumber, 100n);
  assert.equal(logs[0]?.logIndex, 2n);
  subscription.close();
  await subscription.done;
});

test("exact-address subscription rejects the matching topic from another emitter", async () => {
  const { socket, client } = setup();
  const ready = client.subscribe(() => undefined);
  socket.emit("open");
  socket.emitJson({ jsonrpc: "2.0", id: 1, result: "0x1237" });
  socket.emitJson({ jsonrpc: "2.0", id: 2, result: "0xsub" });
  const subscription = await ready;
  socket.emitJson({
    jsonrpc: "2.0",
    method: "eth_subscription",
    params: {
      subscription: "0xsub",
      result: {
        address: `0x${"40".repeat(20)}`,
        topics: [TOPIC],
        data: "0x",
        blockNumber: "0x64",
        transactionHash: `0x${"50".repeat(32)}`,
        logIndex: "0x0",
        removed: false,
      },
    },
  });
  await assert.rejects(subscription.done, /outside the bound filter/);
});

test("subscribes topic-only and accepts the matching topic from any emitter", async () => {
  const { socket, logs, client } = setup({});
  const ready = client.subscribe((log) => logs.push(log));
  socket.emit("open");
  socket.emitJson({ jsonrpc: "2.0", id: 1, result: "0x1237" });
  const subscribeRequest = JSON.parse(socket.sent[1] ?? "{}") as {
    readonly params?: readonly unknown[];
  };
  assert.deepEqual(subscribeRequest.params, ["logs", { topics: [TOPIC] }]);
  socket.emitJson({ jsonrpc: "2.0", id: 2, result: "0xsub" });
  const subscription = await ready;
  const unknownFactory = `0x${"40".repeat(20)}` as Hex;
  socket.emitJson({
    jsonrpc: "2.0",
    method: "eth_subscription",
    params: {
      subscription: "0xsub",
      result: {
        address: unknownFactory,
        topics: [TOPIC],
        data: "0x",
        blockNumber: "0x64",
        transactionHash: `0x${"50".repeat(32)}`,
        logIndex: "0x0",
        removed: false,
      },
    },
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.address, unknownFactory);
  subscription.close();
  await subscription.done;
});

test("topic-only subscription still rejects a notification with the wrong topic", async () => {
  const { socket, client } = setup({});
  const ready = client.subscribe(() => undefined);
  socket.emit("open");
  socket.emitJson({ jsonrpc: "2.0", id: 1, result: "0x1237" });
  socket.emitJson({ jsonrpc: "2.0", id: 2, result: "0xsub" });
  const subscription = await ready;
  socket.emitJson({
    jsonrpc: "2.0",
    method: "eth_subscription",
    params: {
      subscription: "0xsub",
      result: {
        address: `0x${"40".repeat(20)}`,
        topics: [`0x${"60".repeat(32)}`],
        data: "0x",
        blockNumber: "0x64",
        transactionHash: `0x${"50".repeat(32)}`,
        logIndex: "0x0",
        removed: false,
      },
    },
  });
  await assert.rejects(subscription.done, /outside the bound filter/);
});

test("rejects a wrong-chain log transport without exposing its URL", async () => {
  const { socket, client } = setup();
  const ready = client.subscribe(() => undefined);
  socket.emit("open");
  socket.emitJson({ jsonrpc: "2.0", id: 1, result: "0x1" });
  await assert.rejects(
    ready,
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("expected Robinhood mainnet 4663") &&
      !error.message.includes("provider.example"),
  );
});
