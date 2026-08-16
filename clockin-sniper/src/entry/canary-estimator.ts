import { CanonicalInvariantError, stableHash, type ExecutionPlan } from "../core/canonical.js";

export type EstimatorState =
  | "DECLARED_ONLY"
  | "CANARY_PENDING"
  | "CALIBRATED"
  | "CONTINUOUSLY_UPDATED"
  | "DRIFTED"
  | "CONFOUNDED"
  | "UNKNOWN";

export interface CanaryInputSnapshot {
  readonly snapshotId: string;
  readonly mechanismProfileId: string;
  readonly profileRevision: number;
  readonly poolObservationId: string;
  readonly parentBlockNumber: bigint;
  readonly parentBlockHash: `0x${string}`;
  readonly declaredFeeBps: number;
  readonly curveStateHash: string;
  readonly spotNoImpactTokenOutRaw?: bigint;
  readonly grossNoFeeTokenOutRaw?: bigint;
  readonly protocolPreviewTokenOutRaw?: bigint;
  readonly capRaw: bigint;
  readonly inWindow: boolean;
  readonly quoteAsset: `0x${string}`;
  readonly principalRaw: bigint;
  readonly minOutputRaw: bigint;
  readonly sourceObservedAt: string;
  readonly sourceExpiresAt: string;
  readonly evidenceIds: readonly string[];
}

export interface CanaryEffectInput {
  readonly receiptStatus: "SUCCESS" | "REVERTED";
  readonly actualTokenOutRaw: bigint;
  readonly gasCostRaw: bigint;
  readonly principalDeltaRaw: bigint;
  readonly receiptBlockNumber: bigint;
  readonly receiptTxHash: `0x${string}`;
  readonly tokenBalanceBeforeRaw: bigint;
  readonly tokenBalanceAfterRaw: bigint;
  readonly transferLogTokenOutRaw: bigint;
  readonly poolTokenOutBeforeTransferTaxRaw?: bigint;
  readonly evidenceIds: readonly string[];
}

export interface FrictionEstimate {
  readonly estimateId: string;
  readonly state: EstimatorState;
  readonly declaredPoolFeeBps: number;
  readonly impliedTotalBuyDragBps?: number;
  readonly executionDriftBps?: number;
  readonly tokenTransferTaxBps: number | "UNKNOWN";
  readonly curvePriceImpactBps: number | "CONSTRAINED_BY_ADAPTER" | "UNKNOWN";
  readonly actualTokenOutRaw: bigint;
  readonly gasCostRaw: bigint;
  readonly stopUnsentLanes: boolean;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
}

export function createCanaryInputSnapshot(
  input: Omit<CanaryInputSnapshot, "snapshotId">,
): CanaryInputSnapshot {
  if (input.principalRaw <= 0n || input.minOutputRaw <= 0n) {
    throw new RangeError("canary principal and minOut must be positive");
  }
  if (input.sourceExpiresAt < input.sourceObservedAt) {
    throw new RangeError("canary source expiry precedes its observation");
  }
  return Object.freeze({
    ...input,
    snapshotId: `canary:${stableHash({
      ...input,
      parentBlockNumber: input.parentBlockNumber.toString(),
      spotNoImpactTokenOutRaw: input.spotNoImpactTokenOutRaw?.toString(),
      grossNoFeeTokenOutRaw: input.grossNoFeeTokenOutRaw?.toString(),
      protocolPreviewTokenOutRaw: input.protocolPreviewTokenOutRaw?.toString(),
      capRaw: input.capRaw.toString(),
      principalRaw: input.principalRaw.toString(),
      minOutputRaw: input.minOutputRaw.toString(),
    })}`,
  });
}

export function assertCanarySnapshotMatchesPlan(
  snapshot: CanaryInputSnapshot,
  plan: ExecutionPlan,
): void {
  if (snapshot.profileRevision !== plan.mechanismProfileRevision) {
    throw new CanonicalInvariantError(
      "PROFILE_STALE",
      "canary snapshot and execution plan use different mechanism profile revisions",
    );
  }
  if (snapshot.parentBlockNumber.toString() !== plan.quoteBlock) {
    throw new CanonicalInvariantError(
      "QUOTE_STALE",
      "canary snapshot and execution plan use different block references",
    );
  }
  if (!plan.evidenceIds.includes(snapshot.snapshotId)) {
    throw new CanonicalInvariantError(
      "EVIDENCE_INCOMPLETE",
      "execution plan does not bind the canary snapshot evidence",
    );
  }
}

function dragBps(actual: bigint, reference: bigint): number {
  if (reference <= 0n || actual > reference) return 0;
  return Number(((reference - actual) * 10_000n) / reference);
}

export function reconcileCanary(
  snapshot: CanaryInputSnapshot,
  effect: CanaryEffectInput,
  maximumExecutionDriftBps: number,
): FrictionEstimate {
  if (effect.receiptStatus === "REVERTED") {
    return Object.freeze({
      estimateId: `estimate:${stableHash(effect.receiptTxHash)}`,
      state: "UNKNOWN",
      declaredPoolFeeBps: snapshot.declaredFeeBps,
      tokenTransferTaxBps: "UNKNOWN",
      curvePriceImpactBps: "UNKNOWN",
      actualTokenOutRaw: 0n,
      gasCostRaw: effect.gasCostRaw,
      stopUnsentLanes: true,
      reason: "canary receipt reverted",
      evidenceIds: Object.freeze([...snapshot.evidenceIds, ...effect.evidenceIds]),
    });
  }
  const actualBalanceDelta = effect.tokenBalanceAfterRaw - effect.tokenBalanceBeforeRaw;
  if (effect.actualTokenOutRaw <= 0n || actualBalanceDelta <= 0n) {
    return Object.freeze({
      estimateId: `estimate:${stableHash(effect.receiptTxHash)}`,
      state: "UNKNOWN",
      declaredPoolFeeBps: snapshot.declaredFeeBps,
      tokenTransferTaxBps: "UNKNOWN",
      curvePriceImpactBps: "UNKNOWN",
      actualTokenOutRaw: effect.actualTokenOutRaw,
      gasCostRaw: effect.gasCostRaw,
      stopUnsentLanes: true,
      reason: "receipt succeeded without a positive token balance delta",
      evidenceIds: Object.freeze([...snapshot.evidenceIds, ...effect.evidenceIds]),
    });
  }
  if (
    actualBalanceDelta !== effect.actualTokenOutRaw ||
    (effect.poolTokenOutBeforeTransferTaxRaw === undefined &&
      effect.transferLogTokenOutRaw !== effect.actualTokenOutRaw) ||
    (effect.poolTokenOutBeforeTransferTaxRaw !== undefined &&
      effect.transferLogTokenOutRaw !== effect.poolTokenOutBeforeTransferTaxRaw)
  ) {
    return Object.freeze({
      estimateId: `estimate:${stableHash(effect.receiptTxHash)}`,
      state: "CONFOUNDED",
      declaredPoolFeeBps: snapshot.declaredFeeBps,
      tokenTransferTaxBps: "UNKNOWN",
      curvePriceImpactBps: "UNKNOWN",
      actualTokenOutRaw: effect.actualTokenOutRaw,
      gasCostRaw: effect.gasCostRaw,
      stopUnsentLanes: true,
      reason: "balance delta, adapter output and Transfer logs disagree",
      evidenceIds: Object.freeze([...snapshot.evidenceIds, ...effect.evidenceIds]),
    });
  }
  const impliedTotalBuyDragBps =
    snapshot.grossNoFeeTokenOutRaw === undefined
      ? undefined
      : dragBps(effect.actualTokenOutRaw, snapshot.grossNoFeeTokenOutRaw);
  const executionDriftBps =
    snapshot.protocolPreviewTokenOutRaw === undefined
      ? undefined
      : dragBps(effect.actualTokenOutRaw, snapshot.protocolPreviewTokenOutRaw);
  const tokenTransferTaxBps =
    effect.poolTokenOutBeforeTransferTaxRaw === undefined
      ? "UNKNOWN"
      : dragBps(effect.actualTokenOutRaw, effect.poolTokenOutBeforeTransferTaxRaw);
  const curvePriceImpactBps =
    snapshot.spotNoImpactTokenOutRaw === undefined || snapshot.grossNoFeeTokenOutRaw === undefined
      ? snapshot.grossNoFeeTokenOutRaw === undefined
        ? "UNKNOWN"
        : "CONSTRAINED_BY_ADAPTER"
      : dragBps(snapshot.grossNoFeeTokenOutRaw, snapshot.spotNoImpactTokenOutRaw);
  const drifted = executionDriftBps !== undefined && executionDriftBps > maximumExecutionDriftBps;
  return Object.freeze({
    estimateId: `estimate:${stableHash({
      txHash: effect.receiptTxHash,
      snapshotId: snapshot.snapshotId,
    })}`,
    state: drifted ? "DRIFTED" : "CALIBRATED",
    declaredPoolFeeBps: snapshot.declaredFeeBps,
    ...(impliedTotalBuyDragBps === undefined ? {} : { impliedTotalBuyDragBps }),
    ...(executionDriftBps === undefined ? {} : { executionDriftBps }),
    tokenTransferTaxBps,
    curvePriceImpactBps,
    actualTokenOutRaw: effect.actualTokenOutRaw,
    gasCostRaw: effect.gasCostRaw,
    stopUnsentLanes: drifted,
    reason: drifted ? "execution drift exceeded configured threshold" : "canary calibrated",
    evidenceIds: Object.freeze([...snapshot.evidenceIds, ...effect.evidenceIds]),
  });
}

export class StatefulFrictionEstimator {
  readonly #maximumExecutionDriftBps: number;
  #state: EstimatorState = "DECLARED_ONLY";
  #pendingSnapshot: CanaryInputSnapshot | null = null;
  #latestEstimate: FrictionEstimate | null = null;

  constructor(maximumExecutionDriftBps: number) {
    if (
      !Number.isSafeInteger(maximumExecutionDriftBps) ||
      maximumExecutionDriftBps < 0 ||
      maximumExecutionDriftBps > 10_000
    ) {
      throw new RangeError("maximum execution drift must be in 0..10000 bps");
    }
    this.#maximumExecutionDriftBps = maximumExecutionDriftBps;
  }

  markCanaryPending(snapshot: CanaryInputSnapshot): void {
    if (this.#state !== "DECLARED_ONLY") {
      throw new Error(`cannot mark canary pending from ${this.#state}`);
    }
    this.#pendingSnapshot = snapshot;
    this.#state = "CANARY_PENDING";
  }

  reconcile(effect: CanaryEffectInput): FrictionEstimate {
    if (this.#pendingSnapshot === null || this.#state !== "CANARY_PENDING") {
      throw new Error("no canary snapshot is pending reconciliation");
    }
    const estimate = reconcileCanary(this.#pendingSnapshot, effect, this.#maximumExecutionDriftBps);
    this.#latestEstimate = estimate;
    this.#pendingSnapshot = null;
    this.#state = estimate.state;
    return estimate;
  }

  update(snapshot: CanaryInputSnapshot, effect: CanaryEffectInput): FrictionEstimate {
    if (this.#state !== "CALIBRATED" && this.#state !== "CONTINUOUSLY_UPDATED") {
      throw new Error(`cannot continuously update estimator from ${this.#state}`);
    }
    const estimate = reconcileCanary(snapshot, effect, this.#maximumExecutionDriftBps);
    this.#latestEstimate = estimate;
    this.#state = estimate.state === "CALIBRATED" ? "CONTINUOUSLY_UPDATED" : estimate.state;
    return Object.freeze({
      ...estimate,
      state: this.#state,
      reason:
        this.#state === "CONTINUOUSLY_UPDATED"
          ? "friction estimate continuously updated from a later canonical effect"
          : estimate.reason,
    });
  }

  snapshot(): Readonly<{
    state: EstimatorState;
    pendingSnapshotId?: string;
    latestEstimateId?: string;
  }> {
    return Object.freeze({
      state: this.#state,
      ...(this.#pendingSnapshot === null
        ? {}
        : { pendingSnapshotId: this.#pendingSnapshot.snapshotId }),
      ...(this.#latestEstimate === null
        ? {}
        : { latestEstimateId: this.#latestEstimate.estimateId }),
    });
  }
}
