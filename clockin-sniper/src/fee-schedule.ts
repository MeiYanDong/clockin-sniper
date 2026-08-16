import {
  BPS_DENOMINATOR,
  USD_MICROS_PER_USD,
  type FeeBand,
  type FeeScheduleConfig,
} from "./domain.js";

function assertSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer`);
  }
}

function validateConfig(config: FeeScheduleConfig): void {
  assertSafeInteger("startFeeBps", config.startFeeBps);
  assertSafeInteger("floorFeeBps", config.floorFeeBps);
  assertSafeInteger("batchCount", config.batchCount);
  assertSafeInteger("windowDurationMs", config.windowDurationMs);

  if (config.startFeeBps < 0 || config.startFeeBps > Number(BPS_DENOMINATOR)) {
    throw new RangeError("startFeeBps must be between 0 and 10000");
  }
  if (config.floorFeeBps < 0 || config.floorFeeBps > config.startFeeBps) {
    throw new RangeError("floorFeeBps must be between 0 and startFeeBps");
  }
  if (config.batchCount < 2) {
    throw new RangeError("batchCount must be at least 2");
  }
  if (config.windowDurationMs <= 0) {
    throw new RangeError("windowDurationMs must be positive");
  }
  if (config.grossUsdMicrosPerBatch <= 0n) {
    throw new RangeError("grossUsdMicrosPerBatch must be positive");
  }
}

/**
 * Builds inclusive fee bands: tranche 1 is at the initial fee and the last
 * tranche is at the contract floor. Integer basis-point rounding is stable.
 */
export function buildFeeSchedule(config: FeeScheduleConfig): readonly FeeBand[] {
  validateConfig(config);

  const intervalCount = config.batchCount - 1;
  const feeDelta = config.startFeeBps - config.floorFeeBps;

  return Object.freeze(
    Array.from({ length: config.batchCount }, (_, index): FeeBand => {
      const targetFeeBps =
        index === intervalCount
          ? config.floorFeeBps
          : config.startFeeBps - Math.round((feeDelta * index) / intervalCount);
      const referenceOffsetMs =
        index === intervalCount
          ? config.windowDurationMs
          : Math.round((config.windowDurationMs * index) / intervalCount);

      return Object.freeze({
        trancheNumber: index + 1,
        targetFeeBps,
        referenceOffsetMs,
        grossUsdMicros: config.grossUsdMicrosPerBatch,
      });
    }),
  );
}

export interface ScheduleCostEstimate {
  readonly grossUsdMicros: bigint;
  readonly dynamicFeeUsdMicros: bigint;
  readonly curveInputAfterFeeUsdMicros: bigint;
  readonly averageFeeBps: number;
}

/** Estimate only the configured dynamic fee. Gas and curve price impact are excluded. */
export function estimateScheduleCost(schedule: readonly FeeBand[]): ScheduleCostEstimate {
  if (schedule.length === 0) {
    throw new RangeError("schedule must not be empty");
  }

  let grossUsdMicros = 0n;
  let dynamicFeeUsdMicros = 0n;
  let feeBpsSum = 0;

  for (const band of schedule) {
    grossUsdMicros += band.grossUsdMicros;
    dynamicFeeUsdMicros += (band.grossUsdMicros * BigInt(band.targetFeeBps)) / BPS_DENOMINATOR;
    feeBpsSum += band.targetFeeBps;
  }

  return Object.freeze({
    grossUsdMicros,
    dynamicFeeUsdMicros,
    curveInputAfterFeeUsdMicros: grossUsdMicros - dynamicFeeUsdMicros,
    averageFeeBps: feeBpsSum / schedule.length,
  });
}

export function formatUsdMicros(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / USD_MICROS_PER_USD;
  const fractional = (absolute % USD_MICROS_PER_USD).toString().padStart(6, "0").replace(/0+$/, "");

  return fractional.length > 0 ? `${sign}${whole}.${fractional}U` : `${sign}${whole}U`;
}
