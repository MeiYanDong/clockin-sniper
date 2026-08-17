import { HttpJsonRpcClient } from "../rpc/http-json-rpc.js";
import { ROBINHOOD_PUBLIC_RPC_URL } from "../rpc/robinhood.js";
import type { JsonRpcRequester } from "../rpc/types.js";

export interface PublicRpcUsageSnapshot {
  readonly providerId: "robinhood-public-http";
  readonly endpointClass: "OFFICIAL_PUBLIC_HTTP";
  readonly totalRequests: number;
  readonly requestsByMethod: Readonly<Record<string, number>>;
  readonly lastRequestAt: string | null;
}

/**
 * The Control Plane gets no endpoint input. Its only chain transport is the
 * canonical Robinhood public HTTP RPC, so an environment or credential change
 * cannot silently route the always-on observer through a paid provider.
 */
export class PublicControlRpc implements JsonRpcRequester {
  readonly providerId = "robinhood-public-http";
  readonly #client: HttpJsonRpcClient;
  readonly #now: () => number;
  readonly #requestsByMethod = new Map<string, number>();
  #totalRequests = 0;
  #lastRequestAt: string | null = null;

  constructor(
    options: {
      readonly timeoutMs?: number;
      readonly fetchFn?: typeof fetch;
      readonly now?: () => number;
    } = {},
  ) {
    this.#client = new HttpJsonRpcClient({
      providerId: this.providerId,
      url: ROBINHOOD_PUBLIC_RPC_URL,
      timeoutMs: options.timeoutMs ?? 8_000,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    });
    this.#now = options.now ?? Date.now;
  }

  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    this.#totalRequests += 1;
    this.#requestsByMethod.set(method, (this.#requestsByMethod.get(method) ?? 0) + 1);
    this.#lastRequestAt = new Date(this.#now()).toISOString();
    return this.#client.request<T>(method, params);
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
      lastRequestAt: this.#lastRequestAt,
    });
  }
}
