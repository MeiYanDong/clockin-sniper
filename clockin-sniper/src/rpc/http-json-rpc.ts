import { JsonRpcRequestError, type JsonRpcErrorShape, type JsonRpcRequester } from "./types.js";

interface JsonRpcResponse<T> {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly result?: T;
  readonly error?: JsonRpcErrorShape;
}

export interface HttpJsonRpcClientOptions {
  readonly providerId: string;
  readonly url: string;
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
}

export class HttpJsonRpcClient implements JsonRpcRequester {
  readonly providerId: string;
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  #nextId = 1;

  constructor(options: HttpJsonRpcClientOptions) {
    if (options.providerId.trim().length === 0) {
      throw new RangeError("providerId must not be empty");
    }
    const parsedUrl = new URL(options.url);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      throw new RangeError("JSON-RPC URL must use http or https");
    }
    const timeoutMs = options.timeoutMs ?? 2_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive safe integer");
    }

    this.providerId = options.providerId;
    this.#url = options.url;
    this.#timeoutMs = timeoutMs;
    this.#fetch = options.fetchFn ?? fetch;
  }

  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    if (method.trim().length === 0) {
      throw new RangeError("JSON-RPC method must not be empty");
    }

    const id = this.#nextId;
    this.#nextId += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new JsonRpcRequestError({
          providerId: this.providerId,
          method,
          message: `HTTP ${response.status}`,
        });
      }

      const payload = (await response.json()) as JsonRpcResponse<T>;
      if (payload.error !== undefined) {
        throw new JsonRpcRequestError({
          providerId: this.providerId,
          method,
          message: payload.error.message,
          code: payload.error.code,
          rpcData: payload.error.data,
        });
      }
      if (!("result" in payload)) {
        throw new JsonRpcRequestError({
          providerId: this.providerId,
          method,
          message: "response has no result",
        });
      }
      return payload.result as T;
    } catch (error) {
      if (error instanceof JsonRpcRequestError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new JsonRpcRequestError({
        providerId: this.providerId,
        method,
        message: controller.signal.aborted ? `timeout after ${this.#timeoutMs}ms` : message,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
