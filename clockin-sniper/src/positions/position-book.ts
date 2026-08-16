import {
  stableHash,
  type AggregatePosition,
  type IsoTimestamp,
  type PositionLot,
  type RouteQuote,
} from "../core/canonical.js";

export interface AggregatePositionResult {
  readonly position: AggregatePosition;
  readonly unvaluedLotIds: readonly string[];
}

function sumField(lots: readonly PositionLot[], field: "quantityRaw" | "remainingRaw"): bigint {
  return lots.reduce((sum, lot) => sum + BigInt(lot[field]), 0n);
}

export function aggregatePosition(input: {
  lots: readonly PositionLot[];
  quotesByLotId: ReadonlyMap<string, RouteQuote>;
  realizedProceedsRaw: bigint;
  observedAt: IsoTimestamp;
  evidenceIds?: readonly string[];
}): AggregatePositionResult {
  if (input.lots.length === 0) throw new RangeError("at least one position lot is required");
  if (input.realizedProceedsRaw < 0n) throw new RangeError("realized proceeds cannot be negative");
  const first = input.lots[0] as PositionLot;
  for (const lot of input.lots) {
    if (
      lot.strategyId !== first.strategyId ||
      lot.launchId !== first.launchId ||
      lot.tokenAddress.toLowerCase() !== first.tokenAddress.toLowerCase()
    ) {
      throw new Error("cannot aggregate lots from different strategies, launches or tokens");
    }
  }
  const canonicalLots = [...input.lots].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.lotId.localeCompare(right.lotId),
  );
  const unvaluedLotIds: string[] = [];
  let executableNetLiquidationRaw = 0n;
  for (const lot of canonicalLots) {
    if (BigInt(lot.remainingRaw) === 0n) continue;
    const quote = input.quotesByLotId.get(lot.lotId);
    if (quote === undefined || BigInt(quote.tokenInputRaw) !== BigInt(lot.remainingRaw)) {
      unvaluedLotIds.push(lot.lotId);
      continue;
    }
    executableNetLiquidationRaw += BigInt(quote.netOutputRaw);
  }
  const totalQuantityRaw = sumField(canonicalLots, "quantityRaw");
  const remainingQuantityRaw = sumField(canonicalLots, "remainingRaw");
  const totalActualCostRaw = canonicalLots.reduce(
    (sum, lot) => sum + BigInt(lot.principalCostRaw) + BigInt(lot.entryGasCostRaw),
    0n,
  );
  const anyUnknown = canonicalLots.some((lot) => lot.state === "UNKNOWN");
  const state: AggregatePosition["state"] = anyUnknown
    ? "UNKNOWN"
    : remainingQuantityRaw === 0n
      ? "CLOSED"
      : remainingQuantityRaw < totalQuantityRaw
        ? "PARTIALLY_EXITED"
        : "OPEN";
  const evidenceIds = Object.freeze([
    ...(input.evidenceIds ?? []),
    ...canonicalLots.flatMap((lot) => lot.evidenceIds),
    ...[...input.quotesByLotId.values()].flatMap((quote) => quote.evidenceIds),
  ]);
  const positionId = `aggregate-position:${stableHash({
    strategyId: first.strategyId,
    launchId: first.launchId,
    lotIds: canonicalLots.map((lot) => lot.lotId),
  })}`;
  const position: AggregatePosition = Object.freeze({
    positionId,
    strategyId: first.strategyId,
    revision: Math.max(...canonicalLots.map((lot) => lot.revision)),
    launchId: first.launchId,
    tokenAddress: first.tokenAddress,
    lotIds: Object.freeze(canonicalLots.map((lot) => lot.lotId)),
    totalQuantityRaw: totalQuantityRaw.toString(),
    remainingQuantityRaw: remainingQuantityRaw.toString(),
    totalActualCostRaw: totalActualCostRaw.toString(),
    realizedProceedsRaw: input.realizedProceedsRaw.toString(),
    executableNetLiquidationRaw: Object.freeze({
      state: "KNOWN",
      value: executableNetLiquidationRaw.toString(),
      observedAt: input.observedAt,
      evidenceIds,
    }),
    state,
    evidenceIds,
    createdAt: canonicalLots[0]?.createdAt ?? input.observedAt,
    updatedAt: input.observedAt,
  });
  return Object.freeze({ position, unvaluedLotIds: Object.freeze(unvaluedLotIds) });
}

export function reconcileLotBalance(
  lot: PositionLot,
  actualBalanceRaw: bigint,
  observedAt: IsoTimestamp,
  evidenceId: string,
): PositionLot {
  if (actualBalanceRaw < 0n) throw new RangeError("actual token balance cannot be negative");
  if (actualBalanceRaw === BigInt(lot.remainingRaw)) return lot;
  return Object.freeze({
    ...lot,
    revision: lot.revision + 1,
    state: "UNKNOWN",
    evidenceIds: Object.freeze([...lot.evidenceIds, evidenceId]),
    updatedAt: observedAt,
  });
}
