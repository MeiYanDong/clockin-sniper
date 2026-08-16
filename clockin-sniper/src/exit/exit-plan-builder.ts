import {
  stableHash,
  type AggregatePosition,
  type ExitPlan,
  type IsoTimestamp,
  type PositionLot,
  type RouteQuote,
} from "../core/canonical.js";
import { PRODUCTION_EXIT_SLIPPAGE_POLICY } from "./entry-exit-control.js";

export function buildExitPlan(input: {
  position: AggregatePosition;
  lot: PositionLot;
  quote: RouteQuote;
  tokenInputRaw: bigint;
  policyStage: ExitPlan["policyStage"];
  maximumSlippageBps: number;
  validityEnvelopeId: string;
  breakGlassAuthorizationId?: string;
  now: IsoTimestamp;
}): ExitPlan {
  if (
    !Number.isSafeInteger(input.maximumSlippageBps) ||
    input.maximumSlippageBps < 0 ||
    input.maximumSlippageBps >= 10_000
  ) {
    throw new RangeError("maximumSlippageBps must be between 0 and 9999");
  }
  const isBreakGlass = input.policyStage === "BREAK_GLASS";
  const policyMaximum = isBreakGlass
    ? PRODUCTION_EXIT_SLIPPAGE_POLICY.breakGlassMaximumSlippageBps
    : PRODUCTION_EXIT_SLIPPAGE_POLICY.routineMaximumSlippageBps;
  if (input.maximumSlippageBps > policyMaximum) {
    throw new RangeError(
      `${isBreakGlass ? "break-glass" : "routine"} exit plan exceeds policy slippage`,
    );
  }
  if (isBreakGlass && (input.breakGlassAuthorizationId?.trim().length ?? 0) === 0) {
    throw new Error("break-glass exit plan requires an explicit authorization audit ID");
  }
  if (!isBreakGlass && input.breakGlassAuthorizationId !== undefined) {
    throw new Error("break-glass authorization cannot be attached to a routine exit plan");
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
    breakGlassAuthorizationId: input.breakGlassAuthorizationId ?? null,
  })}`;
  return Object.freeze({
    exitPlanId,
    strategyId: input.position.strategyId,
    revision: 1,
    launchId: input.position.launchId,
    positionId: input.position.positionId,
    lotId: input.lot.lotId,
    policyStage: input.policyStage,
    ...(input.breakGlassAuthorizationId === undefined
      ? {}
      : { breakGlassAuthorizationId: input.breakGlassAuthorizationId }),
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
