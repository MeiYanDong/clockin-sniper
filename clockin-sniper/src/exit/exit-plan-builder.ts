import {
  stableHash,
  type AggregatePosition,
  type ExitPlan,
  type IsoTimestamp,
  type PositionLot,
  type RouteQuote,
} from "../core/canonical.js";

export function buildExitPlan(input: {
  position: AggregatePosition;
  lot: PositionLot;
  quote: RouteQuote;
  tokenInputRaw: bigint;
  policyStage: ExitPlan["policyStage"];
  maximumSlippageBps: number;
  validityEnvelopeId: string;
  now: IsoTimestamp;
}): ExitPlan {
  if (
    !Number.isSafeInteger(input.maximumSlippageBps) ||
    input.maximumSlippageBps < 0 ||
    input.maximumSlippageBps >= 10_000
  ) {
    throw new RangeError("maximumSlippageBps must be between 0 and 9999");
  }
  if (
    input.quote.lotId !== input.lot.lotId ||
    input.position.launchId !== input.lot.launchId ||
    input.quote.launchId !== input.lot.launchId
  ) {
    throw new Error("exit plan position, lot and quote are not canonically bound");
  }
  if (input.quote.expiresAt < input.now)
    throw new Error("cannot build an exit plan from a stale quote");
  if (input.tokenInputRaw <= 0n || input.tokenInputRaw > BigInt(input.lot.remainingRaw)) {
    throw new RangeError("exit token input is outside the lot remainder");
  }
  const proportionalNet =
    (BigInt(input.quote.netOutputRaw) * input.tokenInputRaw) / BigInt(input.quote.tokenInputRaw);
  const minOutputRaw = (proportionalNet * BigInt(10_000 - input.maximumSlippageBps)) / 10_000n;
  if (minOutputRaw <= 0n) throw new Error("exit plan minOutput is not economically executable");
  const exitPlanId = `exit-plan:${stableHash({
    positionId: input.position.positionId,
    lotId: input.lot.lotId,
    quoteId: input.quote.quoteId,
    tokenInputRaw: input.tokenInputRaw.toString(),
    policyStage: input.policyStage,
  })}`;
  return Object.freeze({
    exitPlanId,
    strategyId: input.position.strategyId,
    revision: 1,
    launchId: input.position.launchId,
    positionId: input.position.positionId,
    lotId: input.lot.lotId,
    policyStage: input.policyStage,
    routeQuoteId: input.quote.quoteId,
    tokenInputRaw: input.tokenInputRaw.toString(),
    minOutputRaw: minOutputRaw.toString(),
    validityEnvelopeId: input.validityEnvelopeId,
    state: "ARMED",
    evidenceIds: Object.freeze([...input.position.evidenceIds, ...input.quote.evidenceIds]),
    createdAt: input.now,
    updatedAt: input.now,
  });
}
