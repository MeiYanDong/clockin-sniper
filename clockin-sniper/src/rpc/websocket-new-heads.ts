import { hexToBigInt } from "./hex.js";
import { ROBINHOOD_MAINNET_CHAIN_ID } from "./robinhood.js";
import type { Hex } from "./types.js";

interface WebSocketEventLike {
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
}

interface WebSocketLike {
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: WebSocketEventLike) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface NewHead {
  readonly blockNumber: bigint;
  readonly blockHash: Hex | null;
  readonly parentHash: Hex | null;
}

export interface NewHeadsSubscription {
  /** Rejects on an unexpected disconnect or protocol failure. */
  readonly done: Promise<void>;
  close(): void;
}

export interface WebSocketNewHeadsClientOptions {
  readonly providerId: string;
  readonly url: string;
  readonly setupTimeoutMs?: number;
  readonly webSocketFactory?: WebSocketFactory;
}

interface RpcEnvelope {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
  readonly params?: {
    readonly subscription?: string;
    readonly result?: {
      readonly number?: unknown;
      readonly hash?: unknown;
      readonly parentHash?: unknown;
    };
  };
}

function optionalHex(value: unknown): Hex | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? (value as Hex) : null;
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

/**
 * Authenticated WSS is a wake-up channel only. Every trading decision must be
 * re-read over canonical HTTP JSON-RPC at the emitted block number.
 */
export class WebSocketNewHeadsClient {
  readonly providerId: string;
  readonly #url: string;
  readonly #setupTimeoutMs: number;
  readonly #webSocketFactory: WebSocketFactory;

  constructor(options: WebSocketNewHeadsClientOptions) {
    if (options.providerId.trim().length === 0) {
      throw new RangeError("providerId must not be empty");
    }
    const parsedUrl = new URL(options.url);
    if (parsedUrl.protocol !== "wss:" && parsedUrl.protocol !== "ws:") {
      throw new RangeError("WebSocket JSON-RPC URL must use ws or wss");
    }
    const setupTimeoutMs = options.setupTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(setupTimeoutMs) || setupTimeoutMs <= 0) {
      throw new RangeError("setupTimeoutMs must be a positive safe integer");
    }

    this.providerId = options.providerId;
    this.#url = options.url;
    this.#setupTimeoutMs = setupTimeoutMs;
    this.#webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
  }

  subscribe(onHead: (head: NewHead) => void): Promise<NewHeadsSubscription> {
    const socket = this.#webSocketFactory(this.#url);
    const chainRequestId = 1;
    const subscribeRequestId = 2;
    let subscriptionId: string | null = null;
    let readySettled = false;
    let doneSettled = false;
    let userClosed = false;

    let resolveReady!: (value: NewHeadsSubscription) => void;
    let rejectReady!: (reason: Error) => void;
    let resolveDone!: () => void;
    let rejectDone!: (reason: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const ready = new Promise<NewHeadsSubscription>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const subscription: NewHeadsSubscription = Object.freeze({
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

    const setupTimer = setTimeout(() => {
      fail(new Error(`${this.providerId} WebSocket setup timed out`));
    }, this.#setupTimeoutMs);

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
        // The original sanitized error is already propagated.
      }
    };

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({ jsonrpc: "2.0", id: chainRequestId, method: "eth_chainId", params: [] }),
      );
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
            new Error(
              `${this.providerId} is chain ${chainId}, expected Robinhood mainnet ${ROBINHOOD_MAINNET_CHAIN_ID}`,
            ),
          );
          return;
        }
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: subscribeRequestId,
            method: "eth_subscribe",
            params: ["newHeads"],
          }),
        );
        return;
      }

      if (payload.id === subscribeRequestId) {
        if (payload.error !== undefined || typeof payload.result !== "string") {
          fail(new Error(`${this.providerId} eth_subscribe failed`));
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

      const number = payload.params.result?.number;
      if (typeof number !== "string") {
        fail(new Error(`${this.providerId} newHeads notification has no block number`));
        return;
      }
      let blockNumber: bigint;
      try {
        blockNumber = hexToBigInt("newHeads.number", number);
      } catch {
        fail(new Error(`${this.providerId} newHeads notification has an invalid block number`));
        return;
      }

      try {
        onHead(
          Object.freeze({
            blockNumber,
            blockHash: optionalHex(payload.params.result?.hash),
            parentHash: optionalHex(payload.params.result?.parentHash),
          }),
        );
      } catch {
        fail(new Error(`${this.providerId} newHeads consumer failed`));
      }
    });

    socket.addEventListener("error", () => {
      fail(new Error(`${this.providerId} WebSocket transport error`));
    });

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
