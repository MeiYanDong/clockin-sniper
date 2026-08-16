import { CanonicalInvariantError, stableHash } from "../core/canonical.js";

export interface QuoteSnapshot {
  readonly quoteId: string;
  readonly revision: number;
  readonly laneId: string;
  readonly poolObservationId: string;
  readonly profileRevision: number;
  readonly blockNumber: bigint;
  readonly blockHash: `0x${string}`;
  readonly principalRaw: bigint;
  readonly expectedTokenOutRaw: bigint;
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
  readonly evidenceIds: readonly string[];
}

export function createQuoteSnapshot(
  input: Omit<QuoteSnapshot, "quoteId" | "revision"> & { readonly revision?: number },
): QuoteSnapshot {
  if (input.principalRaw <= 0n || input.expectedTokenOutRaw <= 0n) {
    throw new RangeError("quote input and output must be positive");
  }
  if (input.expiresAtMs < input.observedAtMs)
    throw new RangeError("quote expiry precedes observation");
  const revision = input.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new RangeError("quote revision must be a positive integer");
  }
  return Object.freeze({
    ...input,
    revision,
    quoteId: `quote:${stableHash({
      ...input,
      revision,
      blockNumber: input.blockNumber.toString(),
      principalRaw: input.principalRaw.toString(),
      expectedTokenOutRaw: input.expectedTokenOutRaw.toString(),
    })}`,
  });
}

export function reviseQuoteSnapshot(
  previous: QuoteSnapshot,
  input: Omit<QuoteSnapshot, "quoteId" | "revision" | "laneId">,
): QuoteSnapshot {
  return createQuoteSnapshot({
    ...input,
    laneId: previous.laneId,
    revision: previous.revision + 1,
  });
}

export function quoteBoundedMinOut(
  quote: QuoteSnapshot,
  maximumDriftBps: number,
  nowMs: number,
  currentBlockHash: string,
): bigint {
  if (!Number.isSafeInteger(maximumDriftBps) || maximumDriftBps < 0 || maximumDriftBps >= 10_000) {
    throw new RangeError("maximumDriftBps must be between 0 and 9999");
  }
  if (
    nowMs > quote.expiresAtMs ||
    currentBlockHash.toLowerCase() !== quote.blockHash.toLowerCase()
  ) {
    throw new CanonicalInvariantError("QUOTE_STALE", "quote is stale or belongs to another block");
  }
  return (quote.expectedTokenOutRaw * BigInt(10_000 - maximumDriftBps)) / 10_000n;
}

export function speedCanaryMinOut(minimumNonZeroRaw = 1n): bigint {
  if (minimumNonZeroRaw <= 0n) throw new RangeError("speed canary minOut must be non-zero");
  return minimumNonZeroRaw;
}
