import { stableHash, type SignalEvidence } from "../core/canonical.js";

export interface ChainSignalInput {
  readonly strategyId: string;
  readonly sourceKind: SignalEvidence["sourceKind"];
  readonly sourceId: string;
  readonly observedAt: string;
  readonly receivedMonotonicMs?: bigint;
  readonly chainId: number;
  readonly blockNumber?: bigint;
  readonly blockHash?: `0x${string}`;
  readonly transactionHash?: `0x${string}`;
  readonly transactionIndex?: bigint;
  readonly logIndex?: bigint;
  readonly removed?: boolean;
  readonly payload: unknown;
  readonly evidenceLevel?: SignalEvidence["evidenceLevel"];
}

function signalKey(input: ChainSignalInput): string {
  if (
    input.blockHash !== undefined &&
    input.transactionHash !== undefined &&
    input.logIndex !== undefined
  ) {
    return stableHash({
      chainId: input.chainId,
      blockHash: input.blockHash.toLowerCase(),
      transactionHash: input.transactionHash.toLowerCase(),
      logIndex: input.logIndex.toString(),
    });
  }
  return stableHash({
    chainId: input.chainId,
    blockHash: input.blockHash,
    transactionHash: input.transactionHash,
    logIndex: input.logIndex?.toString(),
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    payload: input.payload,
  });
}

export class SignalLedger {
  readonly #signals = new Map<string, SignalEvidence>();
  readonly #removed = new Set<string>();

  ingest(input: ChainSignalInput): SignalEvidence | null {
    const key = signalKey(input);
    if (input.removed === true) {
      this.#removed.add(key);
      const existing = this.#signals.get(key);
      if (existing !== undefined) {
        const removed = Object.freeze({
          ...existing,
          removed: true,
          revision: existing.revision + 1,
        });
        this.#signals.set(key, removed);
        return removed;
      }
    }
    const existing = this.#signals.get(key);
    if (existing !== undefined) return null;

    const evidence: SignalEvidence = Object.freeze({
      evidenceId: `signal:${key}`,
      strategyId: input.strategyId,
      revision: 1,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      occurredAt: Object.freeze({
        state: "UNKNOWN",
        reason: "source occurrence timestamp not provided",
        since: input.observedAt,
      }),
      observedAt: input.observedAt,
      ...(input.receivedMonotonicMs === undefined
        ? {}
        : { receivedMonotonicMs: input.receivedMonotonicMs.toString() }),
      chainId: input.chainId,
      ...(input.blockNumber === undefined ? {} : { blockNumber: input.blockNumber.toString() }),
      ...(input.blockHash === undefined ? {} : { blockHash: input.blockHash }),
      ...(input.transactionHash === undefined ? {} : { transactionHash: input.transactionHash }),
      ...(input.transactionIndex === undefined
        ? {}
        : { transactionIndex: input.transactionIndex.toString() }),
      ...(input.logIndex === undefined ? {} : { logIndex: input.logIndex.toString() }),
      removed: input.removed === true || this.#removed.has(key),
      payloadHash: stableHash(input.payload),
      evidenceLevel: input.evidenceLevel ?? "repository_record",
    });
    this.#signals.set(key, evidence);
    return evidence;
  }

  ordered(): readonly SignalEvidence[] {
    return Object.freeze(
      [...this.#signals.values()].sort((left, right) => {
        const leftBlock = BigInt(left.blockNumber ?? "0");
        const rightBlock = BigInt(right.blockNumber ?? "0");
        if (leftBlock !== rightBlock) return leftBlock < rightBlock ? -1 : 1;
        const leftTx = BigInt(left.transactionIndex ?? "0");
        const rightTx = BigInt(right.transactionIndex ?? "0");
        if (leftTx !== rightTx) return leftTx < rightTx ? -1 : 1;
        const leftLog = BigInt(left.logIndex ?? "0");
        const rightLog = BigInt(right.logIndex ?? "0");
        return leftLog < rightLog ? -1 : leftLog > rightLog ? 1 : 0;
      }),
    );
  }
}
