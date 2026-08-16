import { getAddress } from "ethers";

import { assertAddress, assertHex, hexToBigInt } from "./hex.js";
import { ROBINHOOD_MAINNET_CHAIN_ID } from "./robinhood.js";
import type { Hex } from "./types.js";

interface WebSocketEventLike {
  readonly data?: unknown;
  readonly code?: number;
}

interface WebSocketLike {
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: WebSocketEventLike) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type LogWebSocketFactory = (url: string) => WebSocketLike;

export interface RpcContractLog {
  readonly address: Hex;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: bigint;
  readonly removed: boolean;
}

export interface RawRpcContractLog {
  readonly address?: unknown;
  readonly topics?: unknown;
  readonly data?: unknown;
  readonly blockNumber?: unknown;
  readonly transactionHash?: unknown;
  readonly logIndex?: unknown;
  readonly removed?: unknown;
}

export interface ContractLogSubscription {
  readonly done: Promise<void>;
  close(): void;
}

export interface WebSocketContractLogsClientOptions {
  readonly providerId: string;
  readonly url: string;
  readonly address: Hex;
  readonly topic0: Hex;
  readonly setupTimeoutMs?: number;
  readonly webSocketFactory?: LogWebSocketFactory;
}

interface RpcEnvelope {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
  readonly params?: {
    readonly subscription?: string;
    readonly result?: RawRpcContractLog;
  };
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

export function parseRpcContractLog(
  providerId: string,
  result: RawRpcContractLog | undefined,
): RpcContractLog {
  if (result === undefined) {
    throw new Error(`${providerId} log notification has no result`);
  }
  if (typeof result.address !== "string") {
    throw new Error(`${providerId} log notification has no address`);
  }
  assertAddress("log.address", result.address);
  if (!Array.isArray(result.topics) || result.topics.some((topic) => typeof topic !== "string")) {
    throw new Error(`${providerId} log notification has invalid topics`);
  }
  const topics = result.topics.map((topic, index) => {
    assertHex(`log.topics[${index}]`, topic as string);
    return topic as Hex;
  });
  if (typeof result.data !== "string") throw new Error(`${providerId} log has no data`);
  assertHex("log.data", result.data, true);
  if (typeof result.blockNumber !== "string") {
    throw new Error(`${providerId} log has no blockNumber`);
  }
  if (typeof result.transactionHash !== "string") {
    throw new Error(`${providerId} log has no transactionHash`);
  }
  assertHex("log.transactionHash", result.transactionHash);
  if (result.transactionHash.length !== 66) {
    throw new Error(`${providerId} log transactionHash is not 32 bytes`);
  }
  if (typeof result.logIndex !== "string") {
    throw new Error(`${providerId} log has no logIndex`);
  }

  return Object.freeze({
    address: getAddress(result.address) as Hex,
    topics: Object.freeze(topics),
    data: result.data as Hex,
    blockNumber: hexToBigInt("log.blockNumber", result.blockNumber),
    transactionHash: result.transactionHash as Hex,
    logIndex: hexToBigInt("log.logIndex", result.logIndex),
    removed: result.removed === true,
  });
}

/** Exact-address/topic standard JSON-RPC log subscription for the durable lane. */
export class WebSocketContractLogsClient {
  readonly providerId: string;
  readonly #url: string;
  readonly #address: Hex;
  readonly #topic0: Hex;
  readonly #setupTimeoutMs: number;
  readonly #webSocketFactory: LogWebSocketFactory;

  constructor(options: WebSocketContractLogsClientOptions) {
    if (options.providerId.trim().length === 0) throw new RangeError("providerId is required");
    const parsedUrl = new URL(options.url);
    if (parsedUrl.protocol !== "wss:" && parsedUrl.protocol !== "ws:") {
      throw new RangeError("WebSocket JSON-RPC URL must use ws or wss");
    }
    assertAddress("logs address", options.address);
    assertHex("logs topic0", options.topic0);
    if (options.topic0.length !== 66) throw new RangeError("logs topic0 must be 32 bytes");
    const setupTimeoutMs = options.setupTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(setupTimeoutMs) || setupTimeoutMs <= 0) {
      throw new RangeError("setupTimeoutMs must be a positive safe integer");
    }
    this.providerId = options.providerId;
    this.#url = options.url;
    this.#address = getAddress(options.address) as Hex;
    this.#topic0 = options.topic0;
    this.#setupTimeoutMs = setupTimeoutMs;
    this.#webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
  }

  subscribe(onLog: (log: RpcContractLog) => void): Promise<ContractLogSubscription> {
    const socket = this.#webSocketFactory(this.#url);
    const chainRequestId = 1;
    const subscribeRequestId = 2;
    let subscriptionId: string | null = null;
    let readySettled = false;
    let doneSettled = false;
    let userClosed = false;

    let resolveReady!: (subscription: ContractLogSubscription) => void;
    let rejectReady!: (error: Error) => void;
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const ready = new Promise<ContractLogSubscription>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const subscription: ContractLogSubscription = Object.freeze({
      done,
      close() {
        if (userClosed) return;
        userClosed = true;
        try {
          socket.close(1_000, "client shutdown");
        } catch {
          if (!doneSettled) {
            doneSettled = true;
            resolveDone();
          }
        }
      },
    });

    const setupTimer = setTimeout(
      () => fail(new Error(`${this.providerId} WebSocket setup timed out`)),
      this.#setupTimeoutMs,
    );
    const finishReady = (): void => {
      if (readySettled) return;
      clearTimeout(setupTimer);
      readySettled = true;
      resolveReady(subscription);
    };
    const fail = (error: Error): void => {
      clearTimeout(setupTimer);
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
        if (!doneSettled) {
          doneSettled = true;
          resolveDone();
        }
      } else if (!doneSettled) {
        doneSettled = true;
        rejectDone(error);
      }
      try {
        socket.close(1_011, "protocol failure");
      } catch {
        // The sanitized protocol error is already propagated.
      }
    };

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }));
    });
    socket.addEventListener("message", (event) => {
      let payload: RpcEnvelope;
      try {
        payload = JSON.parse(String(event.data)) as RpcEnvelope;
      } catch {
        fail(new Error(`${this.providerId} WebSocket returned invalid JSON`));
        return;
      }

      if (payload.id === chainRequestId) {
        if (payload.error !== undefined || typeof payload.result !== "string") {
          fail(new Error(`${this.providerId} eth_chainId failed`));
          return;
        }
        let chainId: bigint;
        try {
          chainId = hexToBigInt("eth_chainId", payload.result);
        } catch {
          fail(new Error(`${this.providerId} returned an invalid chain ID`));
          return;
        }
        if (chainId !== ROBINHOOD_MAINNET_CHAIN_ID) {
          fail(
            new Error(`${this.providerId} is chain ${chainId}, expected Robinhood mainnet 4663`),
          );
          return;
        }
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: subscribeRequestId,
            method: "eth_subscribe",
            params: ["logs", { address: this.#address, topics: [this.#topic0] }],
          }),
        );
        return;
      }

      if (payload.id === subscribeRequestId) {
        if (payload.error !== undefined || typeof payload.result !== "string") {
          fail(new Error(`${this.providerId} eth_subscribe logs failed`));
          return;
        }
        subscriptionId = payload.result;
        finishReady();
        return;
      }

      if (
        payload.method !== "eth_subscription" ||
        subscriptionId === null ||
        payload.params?.subscription !== subscriptionId
      ) {
        return;
      }
      try {
        const log = parseRpcContractLog(this.providerId, payload.params?.result);
        if (
          log.address.toLowerCase() !== this.#address.toLowerCase() ||
          log.topics[0]?.toLowerCase() !== this.#topic0.toLowerCase()
        ) {
          throw new Error(`${this.providerId} delivered a log outside the bound filter`);
        }
        onLog(log);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.addEventListener("error", () => fail(new Error(`${this.providerId} WebSocket error`)));
    socket.addEventListener("close", (event) => {
      clearTimeout(setupTimer);
      if (doneSettled) return;
      doneSettled = true;
      if (userClosed) {
        resolveDone();
        return;
      }
      const code = event.code === undefined ? "unknown" : String(event.code);
      const error = new Error(`${this.providerId} WebSocket closed unexpectedly (${code})`);
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
        resolveDone();
      } else {
        rejectDone(error);
      }
    });

    return ready;
  }
}
