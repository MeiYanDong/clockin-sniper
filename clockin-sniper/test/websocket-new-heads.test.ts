import assert from "node:assert/strict";
import test from "node:test";

import { WebSocketNewHeadsClient, type NewHead, type WebSocketFactory } from "../src/index.js";

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

class FakeWebSocket {
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Listener[]>();
  closed = false;

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1_000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", { code, reason });
  }

  emit(type: string, event: { data?: unknown; code?: number; reason?: string } = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  emitJson(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }
}

function setup(): {
  socket: FakeWebSocket;
  factory: WebSocketFactory;
  heads: NewHead[];
  client: WebSocketNewHeadsClient;
} {
  const socket = new FakeWebSocket();
  const factory = (() => socket) as WebSocketFactory;
  const heads: NewHead[] = [];
  const client = new WebSocketNewHeadsClient({
    providerId: "secret-wss",
    url: "wss://provider.example/private-token",
    webSocketFactory: factory,
  });
  return { socket, factory, heads, client };
}

test("verifies chain, subscribes to newHeads, and parses canonical block number", async () => {
  const { socket, heads, client } = setup();
  const ready = client.subscribe((head) => heads.push(head));

  socket.emit("open");
  assert.equal(JSON.parse(socket.sent[0] ?? "{}").method, "eth_chainId");
  socket.emitJson({ jsonrpc: "2.0", id: 1, result: "0x1237" });
  assert.deepEqual(JSON.parse(socket.sent[1] ?? "{}").params, ["newHeads"]);
  socket.emitJson({ jsonrpc: "2.0", id: 2, result: "0xsubscription" });
  const subscription = await ready;

  socket.emitJson({
    jsonrpc: "2.0",
    method: "eth_subscription",
    params: {
      subscription: "0xsubscription",
      result: {
        number: "0x2a",
        hash: `0x${"11".repeat(32)}`,
        parentHash: `0x${"22".repeat(32)}`,
      },
    },
  });
  assert.equal(heads[0]?.blockNumber, 42n);
  assert.equal(heads[0]?.blockHash, `0x${"11".repeat(32)}`);

  subscription.close();
  await subscription.done;
});

test("rejects the wrong chain without exposing the endpoint", async () => {
  const { socket, client } = setup();
  const ready = client.subscribe(() => undefined);
  socket.emit("open");
  socket.emitJson({ jsonrpc: "2.0", id: 1, result: "0x1" });

  await assert.rejects(
    ready,
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("expected Robinhood mainnet 4663") &&
      !error.message.includes("private-token"),
  );
});

test("surfaces an unexpected active disconnect through done", async () => {
  const { socket, client } = setup();
  const ready = client.subscribe(() => undefined);
  socket.emit("open");
  socket.emitJson({ jsonrpc: "2.0", id: 1, result: "0x1237" });
  socket.emitJson({ jsonrpc: "2.0", id: 2, result: "0xsubscription" });
  const subscription = await ready;

  socket.emit("close", { code: 1_006 });
  await assert.rejects(subscription.done, /closed unexpectedly \(1006\)/);
});
