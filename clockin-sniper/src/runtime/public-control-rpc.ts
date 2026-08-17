import { HttpJsonRpcClient } from "../rpc/http-json-rpc.js";
import { ROBINHOOD_PUBLIC_RPC_URL } from "../rpc/robinhood.js";
import { JsonRpcRequestError, type JsonRpcRequester } from "../rpc/types.js";

const DEFAULT_MINIMUM_INTERVAL_MS = 500;
const THROTTLE_BACKOFF_MS = Object.freeze([1_000, 2_000]);

export interface PublicRpcUsageSnapshot {
  readonly providerId: "robinhood-public-http";
  readonly endpointClass: "OFFICIAL_PUBLIC_HTTP";
  readonly totalRequests: number;
  readonly requestsByMethod: Readonly<Record<string, number>>;
  readonly throttledRetries: number;
  readonly lastRequestAt: string | null;
}

/**
 * The Control Plane gets no endpoint input. Its only chain transport is the
 * canonical Robinhood public HTTP RPC, so an environment or credential change
 * cannot silently route the always-on observer through a paid provider.
 */
export class PublicControlRpc implements JsonRpcRequester {
  readonly providerId = "robinhood-public-http";
  readonly minimumIntervalMs: number;
  readonly #client: HttpJsonRpcClient;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #requestsByMethod = new Map<string, number>();
  #queue: Promise<void> = Promise.resolve();
  #nextRequestAtMs = 0;
  #totalRequests = 0;
  #throttledRetries = 0;
  #lastRequestAt: string | null = null;

  constructor(
    options: {
      readonly timeoutMs?: number;
      readonly fetchFn?: typeof fetch;
      readonly now?: () => number;
      readonly sleep?: (milliseconds: number) => Promise<void>;
      readonly minimumIntervalMs?: number;
    } = {},
  ) {
    const minimumIntervalMs = options.minimumIntervalMs ?? DEFAULT_MINIMUM_INTERVAL_MS;
    if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 1) {
      throw new RangeError("minimumIntervalMs must be a positive safe integer");
    }
    this.#client = new HttpJsonRpcClient({
      providerId: this.providerId,
      url: ROBINHOOD_PUBLIC_RPC_URL,
      timeoutMs: options.timeoutMs ?? 8_000,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    });
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.minimumIntervalMs = minimumIntervalMs;
  }

  request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    const result = this.#queue.then(() => this.#requestPaced<T>(method, params));
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #requestPaced<T>(method: string, params: readonly unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const delayMs = Math.max(0, this.#nextRequestAtMs - this.#now());
      if (delayMs > 0) await this.#sleep(delayMs);
      this.#nextRequestAtMs = this.#now() + this.minimumIntervalMs;
      this.#recordRequest(method);
      try {
        return await this.#client.request<T>(method, params);
      } catch (error) {
        const backoffMs = THROTTLE_BACKOFF_MS[attempt];
        if (
          backoffMs === undefined ||
          !(error instanceof JsonRpcRequestError) ||
          !/HTTP 429/u.test(error.message)
        ) {
          throw error;
        }
        this.#throttledRetries += 1;
        await this.#sleep(backoffMs);
      }
    }
  }

  #recordRequest(method: string): void {
    this.#totalRequests += 1;
    this.#requestsByMethod.set(method, (this.#requestsByMethod.get(method) ?? 0) + 1);
    this.#lastRequestAt = new Date(this.#now()).toISOString();
  }

  usageSnapshot(): PublicRpcUsageSnapshot {
    return Object.freeze({
      providerId: this.providerId,
      endpointClass: "OFFICIAL_PUBLIC_HTTP",
      totalRequests: this.#totalRequests,
      requestsByMethod: Object.freeze(
        Object.fromEntries(
          [...this.#requestsByMethod.entries()].sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
      throttledRetries: this.#throttledRetries,
      lastRequestAt: this.#lastRequestAt,
    });
  }
}
