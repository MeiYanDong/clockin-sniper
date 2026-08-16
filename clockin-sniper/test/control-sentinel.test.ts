import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type CanonicalLogFilter,
  type CanonicalRpcLog,
  DurableLogChannel,
  type DurableLogTransport,
  KnownFactorySentinel,
  type LogSubscription,
} from "../src/control/durable-log-channel.js";
import { SignalLedger } from "../src/control/signal-ledger.js";
import type { Hex } from "../src/rpc/types.js";

const FACTORY_A = `0x${"1".repeat(40)}` as Hex;
const FACTORY_B = `0x${"2".repeat(40)}` as Hex;
const TOPIC = `0x${"a".repeat(64)}` as Hex;

function log(blockNumber: bigint, overrides: Partial<CanonicalRpcLog> = {}): CanonicalRpcLog {
  return Object.freeze({
    address: FACTORY_A,
    topics: [TOPIC],
    data: "0x" as Hex,
    blockNumber,
    blockHash: `0x${blockNumber.toString(16).padStart(64, "0")}` as Hex,
    transactionHash: `0x${(blockNumber + 100n).toString(16).padStart(64, "0")}` as Hex,
    transactionIndex: 0n,
    logIndex: 0n,
    removed: false,
    ...overrides,
  });
}

class FakeLogTransport implements DurableLogTransport {
  readonly providerId: string;
  head = 0n;
  backfilled: CanonicalRpcLog[] = [];
  filters: CanonicalLogFilter[] = [];
  subscribed = false;
  readonly sequence: string[] = [];
  #onLog: ((value: CanonicalRpcLog) => void) | null = null;
  #onDisconnect: ((error: Error) => void) | null = null;
  onLatestBlock: (() => void) | null = null;

  constructor(providerId: string) {
    this.providerId = providerId;
  }

  async subscribe(
    filter: CanonicalLogFilter,
    onLog: (value: CanonicalRpcLog) => void,
    onDisconnect: (error: Error) => void,
  ): Promise<LogSubscription> {
    this.sequence.push("subscribe");
    this.filters.push(filter);
    this.subscribed = true;
    this.#onLog = onLog;
    this.#onDisconnect = onDisconnect;
    return Object.freeze({ close: () => (this.subscribed = false) });
  }

  async latestBlockNumber(): Promise<bigint> {
    this.sequence.push("head");
    this.onLatestBlock?.();
    return this.head;
  }

  async backfill(
    _filter: CanonicalLogFilter,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<readonly CanonicalRpcLog[]> {
    this.sequence.push(`backfill:${fromBlock}-${toBlock}`);
    return this.backfilled.filter(
      (value) => value.blockNumber >= fromBlock && value.blockNumber <= toBlock,
    );
  }

  emit(value: CanonicalRpcLog): void {
    this.#onLog?.(value);
  }

  disconnect(message = "fixture disconnect"): void {
    this.#onDisconnect?.(new Error(message));
  }
}

function channel(input: {
  transport: FakeLogTransport;
  ledger: SignalLedger;
  address?: Hex;
  sourceKind?: "exact_factory" | "topic_wide";
  sourceId?: string;
}): DurableLogChannel {
  return new DurableLogChannel({
    strategyId: "clockin-mainnet-v1",
    sourceKind: input.sourceKind ?? "exact_factory",
    sourceId: input.sourceId ?? "factory-a",
    filter: { ...(input.address === undefined ? {} : { address: input.address }), topic0: TOPIC },
    transport: input.transport,
    ledger: input.ledger,
    initialCursor: 99n,
    decodePayload: (value) => ({ emitter: value.address, data: value.data }),
    isoNow: () => "2026-08-16T00:00:00.000Z",
    monotonicNowNs: () => 123_000_000n,
  });
}

describe("durable Control Sentinel log channels", () => {
  it("subscribes before backfill and deduplicates the live/startup boundary", async () => {
    const transport = new FakeLogTransport("known-a");
    const boundary = log(100n);
    transport.head = 100n;
    transport.backfilled = [boundary];
    transport.onLatestBlock = () => transport.emit(boundary);
    const ledger = new SignalLedger();
    const exact = channel({ transport, ledger, address: FACTORY_A });

    const evidence = await exact.start();
    assert.deepEqual(transport.sequence, ["subscribe", "head", "backfill:100-100"]);
    assert.equal(evidence.length, 1);
    assert.equal(ledger.ordered().length, 1);
    assert.equal(ledger.ordered()[0]?.receivedMonotonicMs, "123");
    assert.equal(ledger.ordered()[0]?.blockHash, boundary.blockHash);
    assert.equal(ledger.ordered()[0]?.transactionIndex, "0");
  });

  it("recovers a disconnect gap from the last durable cursor without a duplicate signal", async () => {
    const transport = new FakeLogTransport("known-a");
    transport.head = 100n;
    transport.backfilled = [log(100n)];
    const ledger = new SignalLedger();
    const exact = channel({ transport, ledger, address: FACTORY_A });
    await exact.start();
    transport.disconnect();
    assert.equal(exact.needsRecovery, true);
    transport.head = 102n;
    transport.backfilled = [log(100n), log(101n), log(102n)];

    const recovered = await exact.recover();
    assert.equal(recovered.length, 2);
    assert.equal(exact.cursor, 102n);
    assert.deepEqual(
      ledger.ordered().map((value) => value.blockNumber),
      ["100", "101", "102"],
    );
  });

  it("runs multiple known Factory profiles in parallel without signer access", async () => {
    const first = new FakeLogTransport("known-a");
    const second = new FakeLogTransport("known-b");
    first.head = 100n;
    second.head = 100n;
    first.backfilled = [log(100n)];
    second.backfilled = [
      log(100n, {
        address: FACTORY_B,
        transactionHash: `0x${"f".repeat(64)}` as Hex,
        logIndex: 1n,
      }),
    ];
    const ledger = new SignalLedger();
    const sentinel = new KnownFactorySentinel([
      channel({ transport: first, ledger, address: FACTORY_A, sourceId: "profile-a" }),
      channel({ transport: second, ledger, address: FACTORY_B, sourceId: "profile-b" }),
    ]);
    const evidence = await sentinel.startAll();
    assert.equal(evidence.length, 2);
    assert.equal(first.subscribed, true);
    assert.equal(second.subscribed, true);
    sentinel.close();
  });

  it("uses an address-less topic filter and deduplicates the same log against exact channel", async () => {
    const exactTransport = new FakeLogTransport("exact");
    const topicTransport = new FakeLogTransport("topic-wide");
    const event = log(100n);
    exactTransport.head = 100n;
    topicTransport.head = 100n;
    exactTransport.backfilled = [event];
    topicTransport.backfilled = [event];
    const ledger = new SignalLedger();
    const exact = channel({ transport: exactTransport, ledger, address: FACTORY_A });
    const topicWide = channel({
      transport: topicTransport,
      ledger,
      sourceKind: "topic_wide",
      sourceId: "launch-topics-v1",
    });

    assert.equal((await exact.start()).length, 1);
    assert.equal((await topicWide.start()).length, 0);
    assert.deepEqual(topicTransport.filters[0], { topic0: TOPIC });
    assert.equal(ledger.ordered().length, 1);
  });

  it("records removed logs as a reconciliation revision", async () => {
    const transport = new FakeLogTransport("known-a");
    transport.head = 100n;
    const original = log(100n);
    transport.backfilled = [original];
    const ledger = new SignalLedger();
    const exact = channel({ transport, ledger, address: FACTORY_A });
    await exact.start();
    transport.emit(Object.freeze({ ...original, removed: true }));
    assert.equal(ledger.ordered()[0]?.removed, true);
    assert.equal(ledger.ordered()[0]?.revision, 2);
  });
});
