import type { SignalEvidence } from "../core/canonical.js";
import type { Hex } from "../rpc/types.js";
import type { SignalLedger } from "./signal-ledger.js";

export interface CanonicalRpcLog {
  readonly address: Hex;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly transactionIndex: bigint;
  readonly logIndex: bigint;
  readonly removed: boolean;
}

export interface CanonicalLogFilter {
  readonly address?: Hex;
  readonly topic0: Hex;
}

export interface LogSubscription {
  close(): void;
}

export interface DurableLogTransport {
  readonly providerId: string;
  subscribe(
    filter: CanonicalLogFilter,
    onLog: (log: CanonicalRpcLog) => void,
    onDisconnect: (error: Error) => void,
  ): Promise<LogSubscription>;
  latestBlockNumber(): Promise<bigint>;
  backfill(
    filter: CanonicalLogFilter,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<readonly CanonicalRpcLog[]>;
}

export interface DurableLogChannelOptions {
  readonly strategyId: string;
  readonly sourceKind: SignalEvidence["sourceKind"];
  readonly sourceId: string;
  readonly filter: CanonicalLogFilter;
  readonly transport: DurableLogTransport;
  readonly ledger: SignalLedger;
  readonly initialCursor: bigint;
  readonly decodePayload: (log: CanonicalRpcLog) => unknown;
  readonly isoNow?: () => string;
  readonly monotonicNowNs?: () => bigint;
}

function compareLogs(left: CanonicalRpcLog, right: CanonicalRpcLog): number {
  if (left.blockNumber !== right.blockNumber) return left.blockNumber < right.blockNumber ? -1 : 1;
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex < right.transactionIndex ? -1 : 1;
  }
  return left.logIndex < right.logIndex ? -1 : left.logIndex > right.logIndex ? 1 : 0;
}

/**
 * A signer-free log channel with a subscribe-before-backfill startup boundary.
 * Disconnect recovery is explicit so the supervisor can apply bounded backoff.
 */
export class DurableLogChannel {
  readonly #options: DurableLogChannelOptions;
  #cursor: bigint;
  #subscription: LogSubscription | null = null;
  #buffer: CanonicalRpcLog[] | null = null;
  #disconnectError: Error | null = null;

  constructor(options: DurableLogChannelOptions) {
    if (options.initialCursor < 0n) throw new RangeError("initial cursor cannot be negative");
    this.#options = options;
    this.#cursor = options.initialCursor;
  }

  get cursor(): bigint {
    return this.#cursor;
  }

  get needsRecovery(): boolean {
    return this.#disconnectError !== null;
  }

  get disconnectReason(): string | null {
    return this.#disconnectError?.message ?? null;
  }

  async start(): Promise<readonly SignalEvidence[]> {
    if (this.#subscription !== null) throw new Error("durable log channel is already started");
    this.#buffer = [];
    this.#disconnectError = null;
    this.#subscription = await this.#options.transport.subscribe(
      this.#options.filter,
      (log) => {
        if (this.#buffer !== null) this.#buffer.push(log);
        else this.#ingest(log);
      },
      (error) => {
        this.#disconnectError = error;
      },
    );

    const head = await this.#options.transport.latestBlockNumber();
    const backfill =
      head > this.#cursor
        ? await this.#options.transport.backfill(this.#options.filter, this.#cursor + 1n, head)
        : [];
    const buffered = this.#buffer;
    this.#buffer = null;
    const emitted: SignalEvidence[] = [];
    for (const log of [...backfill, ...(buffered ?? [])].sort(compareLogs)) {
      const evidence = this.#ingest(log);
      if (evidence !== null) emitted.push(evidence);
    }
    return Object.freeze(emitted);
  }

  async recover(): Promise<readonly SignalEvidence[]> {
    if (this.#disconnectError === null) return Object.freeze([]);
    this.#subscription?.close();
    this.#subscription = null;
    return this.start();
  }

  close(): void {
    this.#subscription?.close();
    this.#subscription = null;
    this.#buffer = null;
  }

  #ingest(log: CanonicalRpcLog): SignalEvidence | null {
    const topic0 = log.topics[0]?.toLowerCase();
    if (topic0 !== this.#options.filter.topic0.toLowerCase()) {
      throw new Error("provider delivered a log outside the topic filter");
    }
    if (
      this.#options.filter.address !== undefined &&
      log.address.toLowerCase() !== this.#options.filter.address.toLowerCase()
    ) {
      throw new Error("provider delivered a log outside the address filter");
    }
    const observedAt = (this.#options.isoNow ?? (() => new Date().toISOString()))();
    const monotonic = (this.#options.monotonicNowNs ?? process.hrtime.bigint)();
    const evidence = this.#options.ledger.ingest({
      strategyId: this.#options.strategyId,
      sourceKind: this.#options.sourceKind,
      sourceId: this.#options.sourceId,
      observedAt,
      receivedMonotonicMs: monotonic / 1_000_000n,
      chainId: 4663,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
      removed: log.removed,
      payload: this.#options.decodePayload(log),
      evidenceLevel: "verified_current",
    });
    if (!log.removed && log.blockNumber > this.#cursor) this.#cursor = log.blockNumber;
    return evidence;
  }
}

export class KnownFactorySentinel {
  readonly #channels: readonly DurableLogChannel[];

  constructor(channels: readonly DurableLogChannel[]) {
    if (channels.length === 0) throw new RangeError("at least one known Factory channel required");
    this.#channels = Object.freeze([...channels]);
  }

  async startAll(): Promise<readonly SignalEvidence[]> {
    const results = await Promise.all(this.#channels.map((channel) => channel.start()));
    return Object.freeze(results.flat());
  }

  async recoverDisconnected(): Promise<readonly SignalEvidence[]> {
    const results = await Promise.all(
      this.#channels.filter((channel) => channel.needsRecovery).map((channel) => channel.recover()),
    );
    return Object.freeze(results.flat());
  }

  close(): void {
    for (const channel of this.#channels) channel.close();
  }
}
