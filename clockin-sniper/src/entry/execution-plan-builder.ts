import { CanonicalInvariantError, stableHash, type ExecutionPlan } from "../core/canonical.js";
import type { QuoteSnapshot } from "./quote-policy.js";

export type EntryPlanDraft = Omit<
  ExecutionPlan,
  "planHash" | "state" | "quoteBlock" | "minOutputRaw"
>;

export function freezeQuoteBoundedEntryPlan(input: {
  readonly draft: EntryPlanDraft;
  readonly quote: QuoteSnapshot;
  readonly minOutputRaw: bigint;
}): ExecutionPlan {
  if (input.quote.laneId !== input.draft.laneId) {
    throw new CanonicalInvariantError("QUOTE_STALE", "quote lane does not match execution plan");
  }
  if (input.quote.profileRevision !== input.draft.mechanismProfileRevision) {
    throw new CanonicalInvariantError(
      "QUOTE_STALE",
      "quote profile revision does not match execution plan",
    );
  }
  if (BigInt(input.draft.valueRaw) !== input.quote.principalRaw) {
    throw new CanonicalInvariantError(
      "QUOTE_STALE",
      "quote principal does not match execution plan value",
    );
  }
  if (input.minOutputRaw <= 0n || input.minOutputRaw > input.quote.expectedTokenOutRaw) {
    throw new RangeError("execution plan minOut is outside its quote bound");
  }
  const canonical = {
    ...input.draft,
    quoteId: input.quote.quoteId,
    quoteRevision: input.quote.revision,
    quoteBlock: input.quote.blockNumber.toString(),
    quoteBlockHash: input.quote.blockHash,
    minOutputRaw: input.minOutputRaw.toString(),
  };
  return Object.freeze({
    ...input.draft,
    planHash: stableHash(canonical),
    quoteBlock: input.quote.blockNumber.toString(),
    minOutputRaw: input.minOutputRaw.toString(),
    state: "FROZEN",
    frozenAt: input.draft.createdAt,
  });
}
