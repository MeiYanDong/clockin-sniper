export const BPS_DENOMINATOR = 10_000n;
export const USD_MICROS_PER_USD = 1_000_000n;

export interface FeeScheduleConfig {
  readonly startFeeBps: number;
  readonly floorFeeBps: number;
  readonly batchCount: number;
  readonly windowDurationMs: number;
  readonly grossUsdMicrosPerBatch: bigint;
}

export interface FeeBand {
  readonly trancheNumber: number;
  readonly targetFeeBps: number;
  readonly referenceOffsetMs: number;
  readonly grossUsdMicros: bigint;
}

export interface ClockInPlanConfig extends FeeScheduleConfig {
  readonly launchId: string;
  readonly windowStartedAtMs: number;
  /** Minimum spacing imposed by the pool for one signer. Defaults to zero. */
  readonly minimumTrancheIntervalMs?: number;
  /**
   * Tranches that may execute from the frozen Factory identity alone. Later
   * tranches require an independent official-CA confirmation.
   */
  readonly chainAuthorizedTrancheCount?: number;
}

export interface FeeObservation {
  readonly observedAtMs: number;
  readonly blockNumber: bigint;
  readonly feeBps: number;
  readonly externalBuyAllowed: boolean;
  /** Cached confirmation only; fetching an announcement must not block the hot path. */
  readonly officialCaConfirmed?: boolean;
}

export interface TrancheIntent {
  readonly intentId: string;
  readonly launchId: string;
  readonly trancheNumber: number;
  readonly attemptNumber: number;
  readonly targetFeeBps: number;
  readonly observedFeeBps: number;
  readonly referenceOffsetMs: number;
  readonly earliestDispatchOffsetMs: number;
  readonly grossUsdMicros: bigint;
  readonly observedAtMs: number;
  readonly blockNumber: bigint;
  readonly expiresAtMs: number;
}

export type SubmissionState = "accepted" | "known" | "unknown";

export interface SubmissionResult {
  readonly state: SubmissionState;
  readonly attemptId: string;
  readonly txHash?: string;
}

export type TrancheStatus = "planned" | "submitting" | "dispatched" | "expired";

export interface TrancheSnapshot {
  readonly band: FeeBand;
  readonly status: TrancheStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly submission: SubmissionResult | null;
}

export type SchedulerStatus = "active" | "completed" | "expired";

export interface SchedulerSnapshot {
  readonly launchId: string;
  readonly status: SchedulerStatus;
  readonly windowStartedAtMs: number;
  readonly expiresAtMs: number;
  readonly submittedBatchCount: number;
  readonly submittedUsdMicros: bigint;
  readonly tranches: readonly TrancheSnapshot[];
}

export interface DispatchSuccess {
  readonly kind: "submitted";
  readonly intent: TrancheIntent;
  readonly submission: SubmissionResult;
}

export interface DispatchFailure {
  readonly kind: "transport_error";
  readonly intent: TrancheIntent;
  readonly error: string;
}

export type DispatchOutcome = DispatchSuccess | DispatchFailure;
