import { HttpJsonRpcClient } from "../rpc/http-json-rpc.js";
import {
  ROBINHOOD_KEYLESS_PUBLIC_RPC_FALLBACK_URL,
  ROBINHOOD_PUBLIC_RPC_URL,
} from "../rpc/robinhood.js";
import { JsonRpcRequestError, type JsonRpcRequester } from "../rpc/types.js";

const DEFAULT_MINIMUM_INTERVAL_MS = 500;
const THROTTLE_BACKOFF_MS = Object.freeze([1_000, 2_000]);
const DEFAULT_OFFICIAL_CIRCUIT_BREAKER_MS = 60_000;

type PublicRpcRoute = "OFFICIAL" | "BLOCKREQ_FALLBACK";

export interface PublicRpcUsageSnapshot {
  readonly providerId: "robinhood-public-http";
  readonly endpointClass: "KEYLESS_PUBLIC_HTTP_POOL";
  readonly activeRoute: PublicRpcRoute;
  readonly officialCircuitOpenUntil: string | null;
  readonly failovers: number;
  readonly totalRequests: number;
  readonly requestsByRoute: Readonly<Record<PublicRpcRoute, number>>;
  readonly requestsByMethod: Readonly<Record<string, number>>;
  readonly requestsByPriority: Readonly<{
    foreground: number;
    background: number;
  }>;
  readonly throttledRetries: number;
  readonly pendingForeground: number;
  readonly pendingBackground: number;
  readonly maximumBackgroundQueueDepth: number;
  readonly lastRequestAt: string | null;
}

type PublicRpcPriority = "FOREGROUND" | "BACKGROUND";

interface QueuedRequest {
  readonly method: string;
  readonly params: readonly unknown[];
  readonly priority: PublicRpcPriority;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * The Control Plane gets no endpoint input. Its only chain transport is this
 * compiled keyless public pool, so an environment or credential change cannot
 * silently route the always-on observer through a paid provider.
 */
export class PublicControlRpc implements JsonRpcRequester {
  readonly providerId = "robinhood-public-http";
  readonly minimumIntervalMs: number;
  readonly #officialClient: HttpJsonRpcClient;
  readonly #fallbackClient: HttpJsonRpcClient;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #officialCircuitBreakerMs: number;
  readonly #requestsByMethod = new Map<string, number>();
  readonly #foregroundQueue: QueuedRequest[] = [];
  readonly #backgroundQueue: QueuedRequest[] = [];
  #draining = false;
  #nextRequestAtMs = 0;
  #totalRequests = 0;
  #foregroundRequests = 0;
  #backgroundRequests = 0;
  #throttledRetries = 0;
  #maximumBackgroundQueueDepth = 0;
  #lastRequestAt: string | null = null;
  #activeRoute: PublicRpcRoute = "OFFICIAL";
  #officialCircuitOpenUntilMs = 0;
  #failovers = 0;
  #officialRequests = 0;
  #fallbackRequests = 0;

  constructor(
    options: {
      readonly timeoutMs?: number;
      readonly fetchFn?: typeof fetch;
      readonly now?: () => number;
      readonly sleep?: (milliseconds: number) => Promise<void>;
      readonly minimumIntervalMs?: number;
      readonly officialCircuitBreakerMs?: number;
    } = {},
  ) {
    const minimumIntervalMs = options.minimumIntervalMs ?? DEFAULT_MINIMUM_INTERVAL_MS;
    if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 1) {
      throw new RangeError("minimumIntervalMs must be a positive safe integer");
    }
    const officialCircuitBreakerMs =
      options.officialCircuitBreakerMs ?? DEFAULT_OFFICIAL_CIRCUIT_BREAKER_MS;
    if (!Number.isSafeInteger(officialCircuitBreakerMs) || officialCircuitBreakerMs < 1) {
      throw new RangeError("officialCircuitBreakerMs must be a positive safe integer");
    }
    this.#officialClient = new HttpJsonRpcClient({
      providerId: "robinhood-official-public-http",
      url: ROBINHOOD_PUBLIC_RPC_URL,
      timeoutMs: options.timeoutMs ?? 8_000,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    });
    this.#fallbackClient = new HttpJsonRpcClient({
      providerId: "blockreq-keyless-public-http",
      url: ROBINHOOD_KEYLESS_PUBLIC_RPC_FALLBACK_URL,
      timeoutMs: options.timeoutMs ?? 8_000,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    });
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.minimumIntervalMs = minimumIntervalMs;
    this.#officialCircuitBreakerMs = officialCircuitBreakerMs;
  }

  request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    return this.#enqueue<T>("FOREGROUND", method, params);
  }

  /**
   * Low-frequency readiness work uses the same physical limiter as foreground
   * chain observation, but cannot occupy the queue ahead of a newly-arrived
   * head or identity request.
   */
  requestBackground<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    return this.#enqueue<T>("BACKGROUND", method, params);
  }

  #enqueue<T>(priority: PublicRpcPriority, method: string, params: readonly unknown[]): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      const queued: QueuedRequest = Object.freeze({
        method,
        params,
        priority,
        resolve: (value: unknown) => resolve(value as T),
        reject,
      });
      if (priority === "FOREGROUND") {
        this.#foregroundQueue.push(queued);
      } else {
        this.#backgroundQueue.push(queued);
        this.#maximumBackgroundQueueDepth = Math.max(
          this.#maximumBackgroundQueueDepth,
          this.#backgroundQueue.length,
        );
      }
    });
    void this.#drain();
    return result;
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (;;) {
        const queued = this.#foregroundQueue.shift() ?? this.#backgroundQueue.shift();
        if (queued === undefined) break;
        try {
          queued.resolve(await this.#requestPaced(queued.priority, queued.method, queued.params));
        } catch (error) {
          queued.reject(error);
        }
      }
    } finally {
      this.#draining = false;
      if (this.#foregroundQueue.length > 0 || this.#backgroundQueue.length > 0) {
        void this.#drain();
      }
    }
  }

  async #requestPaced<T>(
    priority: PublicRpcPriority,
    method: string,
    params: readonly unknown[],
  ): Promise<T> {
    if (this.#now() < this.#officialCircuitOpenUntilMs) {
      return this.#requestFallbackWithRetries<T>(priority, method, params);
    }
    try {
      const result = await this.#requestOnce<T>(
        "OFFICIAL",
        this.#officialClient,
        priority,
        method,
        params,
      );
      this.#activeRoute = "OFFICIAL";
      this.#officialCircuitOpenUntilMs = 0;
      return result;
    } catch (error) {
      if (!isTransientPublicRpcError(error)) throw error;
      this.#throttledRetries += 1;
      this.#failovers += 1;
      this.#officialCircuitOpenUntilMs = this.#now() + this.#officialCircuitBreakerMs;
      this.#activeRoute = "BLOCKREQ_FALLBACK";
      return this.#requestFallbackWithRetries<T>(priority, method, params);
    }
  }

  async #requestFallbackWithRetries<T>(
    priority: PublicRpcPriority,
    method: string,
    params: readonly unknown[],
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.#requestOnce<T>(
          "BLOCKREQ_FALLBACK",
          this.#fallbackClient,
          priority,
          method,
          params,
        );
        this.#activeRoute = "BLOCKREQ_FALLBACK";
        return result;
      } catch (error) {
        const backoffMs = THROTTLE_BACKOFF_MS[attempt];
        if (backoffMs === undefined || !isTransientPublicRpcError(error)) {
          throw error;
        }
        this.#throttledRetries += 1;
        await this.#sleep(backoffMs);
      }
    }
  }

  async #requestOnce<T>(
    route: PublicRpcRoute,
    client: HttpJsonRpcClient,
    priority: PublicRpcPriority,
    method: string,
    params: readonly unknown[],
  ): Promise<T> {
    const delayMs = Math.max(0, this.#nextRequestAtMs - this.#now());
    if (delayMs > 0) await this.#sleep(delayMs);
    this.#nextRequestAtMs = this.#now() + this.minimumIntervalMs;
    this.#recordRequest(route, priority, method);
    return client.request<T>(method, params);
  }

  #recordRequest(route: PublicRpcRoute, priority: PublicRpcPriority, method: string): void {
    this.#totalRequests += 1;
    if (route === "OFFICIAL") this.#officialRequests += 1;
    else this.#fallbackRequests += 1;
    if (priority === "FOREGROUND") this.#foregroundRequests += 1;
    else this.#backgroundRequests += 1;
    this.#requestsByMethod.set(method, (this.#requestsByMethod.get(method) ?? 0) + 1);
    this.#lastRequestAt = new Date(this.#now()).toISOString();
  }

  usageSnapshot(): PublicRpcUsageSnapshot {
    return Object.freeze({
      providerId: this.providerId,
      endpointClass: "KEYLESS_PUBLIC_HTTP_POOL",
      activeRoute: this.#activeRoute,
      officialCircuitOpenUntil:
        this.#officialCircuitOpenUntilMs === 0
          ? null
          : new Date(this.#officialCircuitOpenUntilMs).toISOString(),
      failovers: this.#failovers,
      totalRequests: this.#totalRequests,
      requestsByRoute: Object.freeze({
        OFFICIAL: this.#officialRequests,
        BLOCKREQ_FALLBACK: this.#fallbackRequests,
      }),
      requestsByMethod: Object.freeze(
        Object.fromEntries(
          [...this.#requestsByMethod.entries()].sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
      requestsByPriority: Object.freeze({
        foreground: this.#foregroundRequests,
        background: this.#backgroundRequests,
      }),
      throttledRetries: this.#throttledRetries,
      pendingForeground: this.#foregroundQueue.length,
      pendingBackground: this.#backgroundQueue.length,
      maximumBackgroundQueueDepth: this.#maximumBackgroundQueueDepth,
      lastRequestAt: this.#lastRequestAt,
    });
  }
}

function isTransientPublicRpcError(error: unknown): error is JsonRpcRequestError {
  return (
    error instanceof JsonRpcRequestError &&
    /HTTP (?:429|5\d\d)|timeout after|fetch failed|network|socket/i.test(error.message)
  );
}
