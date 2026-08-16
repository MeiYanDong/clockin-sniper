import { stableHash } from "../core/canonical.js";
import { buildFeeSchedule } from "../fee-schedule.js";

export interface FeeBandLane {
  readonly laneId: string;
  readonly walletId: string;
  readonly trancheNumber: number;
  readonly targetFeeBps: number;
  readonly nominalUsdMicros: bigint;
  readonly reservationId: string;
}

export interface FeeBandPlan {
  readonly plannerRevision: string;
  readonly strategyId: string;
  readonly launchId: string;
  readonly mechanismProfileRevision: number;
  readonly startFeeBps: number;
  readonly floorFeeBps: number;
  readonly lanes: readonly FeeBandLane[];
  readonly createdAt: string;
}

export interface FeeBandPlanContext {
  readonly strategyId: string;
  readonly launchId: string;
  readonly mechanismProfileRevision: number;
  readonly createdAt: string;
}

export function planTenFeeBands(
  startFeeBps: number,
  floorFeeBps: number,
  walletIds: readonly string[],
  reservationIds: readonly string[],
  nominalUsdMicros = 5_000_000n,
  context: FeeBandPlanContext = {
    strategyId: "clockin-mainnet-v1",
    launchId: "UNBOUND",
    mechanismProfileRevision: 1,
    createdAt: "1970-01-01T00:00:00.000Z",
  },
): FeeBandPlan {
  if (walletIds.length !== 10 || reservationIds.length !== 10) {
    throw new RangeError("ten wallet IDs and ten reservation IDs are required");
  }
  if (new Set(walletIds).size !== 10 || new Set(reservationIds).size !== 10) {
    throw new RangeError("wallet and reservation IDs must be unique");
  }
  const bands = buildFeeSchedule({
    startFeeBps,
    floorFeeBps,
    batchCount: 10,
    windowDurationMs: 120_000,
    grossUsdMicrosPerBatch: nominalUsdMicros,
  });
  const lanes = bands.map(
    (band, index): FeeBandLane =>
      Object.freeze({
        laneId: `clockin-entry-${String(index + 1).padStart(2, "0")}`,
        walletId: walletIds[index] as string,
        trancheNumber: band.trancheNumber,
        targetFeeBps: band.targetFeeBps,
        nominalUsdMicros,
        reservationId: reservationIds[index] as string,
      }),
  );
  return Object.freeze({
    plannerRevision: stableHash({
      startFeeBps,
      floorFeeBps,
      walletIds,
      reservationIds,
      nominalUsdMicros: nominalUsdMicros.toString(),
      context,
    }),
    strategyId: context.strategyId,
    launchId: context.launchId,
    mechanismProfileRevision: context.mechanismProfileRevision,
    startFeeBps,
    floorFeeBps,
    lanes: Object.freeze(lanes),
    createdAt: context.createdAt,
  });
}
