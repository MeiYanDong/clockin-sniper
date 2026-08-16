import { stableHash } from "../core/canonical.js";

export interface PriceObservation {
  readonly sourceId: string;
  readonly usdMicrosPerEth: bigint;
  readonly observedAtMs: number;
  readonly evidenceId: string;
}

export type PriceSource = () => Promise<PriceObservation>;

export interface PriceSnapshotPolicy {
  readonly nominalUsdMicrosPerBatch: bigint;
  readonly maximumAgeMs: number;
  readonly maximumDeviationBps: number;
}

export interface PriceSnapshot {
  readonly snapshotId: string;
  readonly revision: number;
  readonly primary: PriceObservation;
  readonly cross: PriceObservation;
  readonly deviationBps: number;
  readonly batchValueWei: bigint;
  readonly nominalUsdMicrosPerBatch: bigint;
  readonly frozenAtMs: number;
  readonly expiresAtMs: number;
  readonly evidenceIds: readonly string[];
}

function validatePrice(observation: PriceObservation, nowMs: number, maximumAgeMs: number): void {
  if (observation.usdMicrosPerEth <= 0n) throw new RangeError("ETH price must be positive");
  if (nowMs - observation.observedAtMs > maximumAgeMs || observation.observedAtMs > nowMs) {
    throw new Error(`price source ${observation.sourceId} is stale or from the future`);
  }
}

export async function freezePriceSnapshot(
  primarySource: PriceSource,
  crossSource: PriceSource,
  policy: PriceSnapshotPolicy,
  nowMs: number,
): Promise<PriceSnapshot> {
  const [primary, cross] = await Promise.all([primarySource(), crossSource()]);
  validatePrice(primary, nowMs, policy.maximumAgeMs);
  validatePrice(cross, nowMs, policy.maximumAgeMs);
  const difference =
    primary.usdMicrosPerEth >= cross.usdMicrosPerEth
      ? primary.usdMicrosPerEth - cross.usdMicrosPerEth
      : cross.usdMicrosPerEth - primary.usdMicrosPerEth;
  const midpoint = (primary.usdMicrosPerEth + cross.usdMicrosPerEth) / 2n;
  const deviationBps = Number((difference * 10_000n) / midpoint);
  if (deviationBps > policy.maximumDeviationBps) {
    throw new Error(
      `price source deviation ${deviationBps} bps exceeds ${policy.maximumDeviationBps} bps`,
    );
  }
  const batchValueWei =
    (policy.nominalUsdMicrosPerBatch * 1_000_000_000_000_000_000n) / primary.usdMicrosPerEth;
  const snapshotBase = {
    primary: { ...primary, usdMicrosPerEth: primary.usdMicrosPerEth.toString() },
    cross: { ...cross, usdMicrosPerEth: cross.usdMicrosPerEth.toString() },
    deviationBps,
    batchValueWei: batchValueWei.toString(),
    nominalUsdMicrosPerBatch: policy.nominalUsdMicrosPerBatch.toString(),
    frozenAtMs: nowMs,
  };
  return Object.freeze({
    snapshotId: `price:${stableHash(snapshotBase)}`,
    revision: 1,
    primary,
    cross,
    deviationBps,
    batchValueWei,
    nominalUsdMicrosPerBatch: policy.nominalUsdMicrosPerBatch,
    frozenAtMs: nowMs,
    expiresAtMs: nowMs + policy.maximumAgeMs,
    evidenceIds: Object.freeze([primary.evidenceId, cross.evidenceId]),
  });
}

export function manualPriceSnapshot(
  batchValueWei: bigint,
  nominalUsdMicrosPerBatch: bigint,
  implicitUsdMicrosPerEth: bigint,
  observedAtMs: number,
  maximumAgeMs: number,
): PriceSnapshot {
  const observation: PriceObservation = Object.freeze({
    sourceId: "operator-fixed-wei",
    usdMicrosPerEth: implicitUsdMicrosPerEth,
    observedAtMs,
    evidenceId: `operator-price:${stableHash({
      batchValueWei: batchValueWei.toString(),
      implicitUsdMicrosPerEth: implicitUsdMicrosPerEth.toString(),
      observedAtMs,
    })}`,
  });
  return Object.freeze({
    snapshotId: `price:${observation.evidenceId}`,
    revision: 1,
    primary: observation,
    cross: observation,
    deviationBps: 0,
    batchValueWei,
    nominalUsdMicrosPerBatch,
    frozenAtMs: observedAtMs,
    expiresAtMs: observedAtMs + maximumAgeMs,
    evidenceIds: [observation.evidenceId],
  });
}

export function assertFreshPriceSnapshot(snapshot: PriceSnapshot, nowMs: number): void {
  if (nowMs > snapshot.expiresAtMs) throw new Error("price snapshot is stale");
}
