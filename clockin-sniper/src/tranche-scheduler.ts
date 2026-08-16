import {
  BPS_DENOMINATOR,
  type ClockInPlanConfig,
  type FeeObservation,
  type SchedulerSnapshot,
  type SchedulerStatus,
  type SubmissionResult,
  type TrancheIntent,
  type TrancheSnapshot,
  type TrancheStatus,
} from "./domain.js";
import { buildFeeSchedule } from "./fee-schedule.js";

interface MutableTranche {
  readonly band: TrancheSnapshot["band"];
  status: TrancheStatus;
  attempts: number;
  lastError: string | null;
  submission: SubmissionResult | null;
}

function validateObservation(observation: FeeObservation): void {
  if (!Number.isSafeInteger(observation.observedAtMs)) {
    throw new TypeError("observedAtMs must be a safe integer");
  }
  if (!Number.isSafeInteger(observation.feeBps)) {
    throw new TypeError("feeBps must be a safe integer");
  }
  if (observation.feeBps < 0 || observation.feeBps > Number(BPS_DENOMINATOR)) {
    throw new RangeError("feeBps must be between 0 and 10000");
  }
  if (observation.blockNumber < 0n) {
    throw new RangeError("blockNumber must not be negative");
  }
}

export class FeeTrancheScheduler {
  readonly #config: ClockInPlanConfig;
  readonly #expiresAtMs: number;
  readonly #minimumTrancheIntervalMs: number;
  readonly #chainAuthorizedTrancheCount: number;
  readonly #tranches: MutableTranche[];
  #lastAttemptedBlock: bigint | null = null;

  constructor(config: ClockInPlanConfig) {
    if (config.launchId.trim().length === 0) {
      throw new RangeError("launchId must not be empty");
    }
    if (!Number.isSafeInteger(config.windowStartedAtMs)) {
      throw new TypeError("windowStartedAtMs must be a safe integer");
    }

    const minimumTrancheIntervalMs = config.minimumTrancheIntervalMs ?? 0;
    if (!Number.isSafeInteger(minimumTrancheIntervalMs) || minimumTrancheIntervalMs < 0) {
      throw new RangeError("minimumTrancheIntervalMs must be a non-negative safe integer");
    }
    const chainAuthorizedTrancheCount = config.chainAuthorizedTrancheCount ?? config.batchCount;
    if (
      !Number.isSafeInteger(chainAuthorizedTrancheCount) ||
      chainAuthorizedTrancheCount < 0 ||
      chainAuthorizedTrancheCount > config.batchCount
    ) {
      throw new RangeError("chainAuthorizedTrancheCount must be between 0 and batchCount");
    }

    const schedule = buildFeeSchedule(config);
    const executionDurationMs = Math.max(
      config.windowDurationMs,
      // One additional interval covers the first transaction's next-block
      // inclusion and receipt observation before the nine inter-buy cooldowns.
      minimumTrancheIntervalMs * config.batchCount,
    );
    const expiresAtMs = config.windowStartedAtMs + executionDurationMs;
    if (!Number.isSafeInteger(expiresAtMs)) {
      throw new RangeError("window end exceeds safe integer range");
    }

    this.#config = Object.freeze({ ...config });
    this.#expiresAtMs = expiresAtMs;
    this.#minimumTrancheIntervalMs = minimumTrancheIntervalMs;
    this.#chainAuthorizedTrancheCount = chainAuthorizedTrancheCount;
    this.#tranches = schedule.map((band) => ({
      band,
      status: "planned",
      attempts: 0,
      lastError: null,
      submission: null,
    }));
  }

  /**
   * Claims at most one tranche per block. Crossing several fee bands therefore
   * catches up over subsequent blocks without merging the fixed 5U intents.
   */
  claimNext(observation: FeeObservation): TrancheIntent | null {
    validateObservation(observation);

    if (observation.observedAtMs < this.#config.windowStartedAtMs) {
      return null;
    }
    if (this.expireAt(observation.observedAtMs)) {
      return null;
    }
    if (!observation.externalBuyAllowed) {
      return null;
    }
    // Duplicate and out-of-order observations must never advance another batch.
    if (this.#lastAttemptedBlock !== null && observation.blockNumber <= this.#lastAttemptedBlock) {
      return null;
    }

    const next = this.#tranches.find(
      (tranche) => tranche.status !== "dispatched" && tranche.status !== "expired",
    );
    if (next === undefined || next.status === "submitting") {
      return null;
    }
    if (
      next.band.trancheNumber > this.#chainAuthorizedTrancheCount &&
      observation.officialCaConfirmed !== true
    ) {
      return null;
    }
    // The on-chain fee is the source of truth for the decay position. The
    // reference offset is descriptive only; local time gates enforce only the
    // pool's per-wallet cooldown.
    const earliestDispatchOffsetMs = this.#minimumTrancheIntervalMs * (next.band.trancheNumber - 1);
    if (observation.observedAtMs < this.#config.windowStartedAtMs + earliestDispatchOffsetMs) {
      return null;
    }
    if (observation.feeBps > next.band.targetFeeBps) {
      return null;
    }

    next.status = "submitting";
    next.attempts += 1;
    next.lastError = null;
    this.#lastAttemptedBlock = observation.blockNumber;

    return Object.freeze({
      intentId: `${this.#config.launchId}:tranche:${next.band.trancheNumber}`,
      launchId: this.#config.launchId,
      trancheNumber: next.band.trancheNumber,
      attemptNumber: next.attempts,
      targetFeeBps: next.band.targetFeeBps,
      observedFeeBps: observation.feeBps,
      referenceOffsetMs: next.band.referenceOffsetMs,
      earliestDispatchOffsetMs,
      grossUsdMicros: next.band.grossUsdMicros,
      observedAtMs: observation.observedAtMs,
      blockNumber: observation.blockNumber,
      expiresAtMs: this.#expiresAtMs,
    });
  }

  markSubmitted(intentId: string, submission: SubmissionResult): void {
    const tranche = this.#findSubmitting(intentId);
    tranche.status = "dispatched";
    tranche.submission = Object.freeze({ ...submission });
    tranche.lastError = null;
  }

  markTransportError(intentId: string, error: string): void {
    const tranche = this.#findSubmitting(intentId);
    tranche.status = "planned";
    tranche.submission = null;
    tranche.lastError = error;
  }

  /** Returns true once the fee-window/cooldown-derived execution deadline has elapsed. */
  expireAt(observedAtMs: number): boolean {
    if (!Number.isSafeInteger(observedAtMs)) {
      throw new TypeError("observedAtMs must be a safe integer");
    }
    if (observedAtMs <= this.#expiresAtMs) {
      return false;
    }
    this.#expireRemaining();
    return true;
  }

  snapshot(): SchedulerSnapshot {
    const tranches: TrancheSnapshot[] = this.#tranches.map((tranche) =>
      Object.freeze({
        band: tranche.band,
        status: tranche.status,
        attempts: tranche.attempts,
        lastError: tranche.lastError,
        submission: tranche.submission,
      }),
    );
    const dispatched = tranches.filter((tranche) => tranche.status === "dispatched");

    return Object.freeze({
      launchId: this.#config.launchId,
      status: this.#status(),
      windowStartedAtMs: this.#config.windowStartedAtMs,
      expiresAtMs: this.#expiresAtMs,
      submittedBatchCount: dispatched.length,
      submittedUsdMicros: dispatched.reduce(
        (total, tranche) => total + tranche.band.grossUsdMicros,
        0n,
      ),
      tranches: Object.freeze(tranches),
    });
  }

  #findSubmitting(intentId: string): MutableTranche {
    const prefix = `${this.#config.launchId}:tranche:`;
    if (!intentId.startsWith(prefix)) {
      throw new RangeError(`intent ${intentId} does not belong to launch ${this.#config.launchId}`);
    }

    const trancheNumber = Number(intentId.slice(prefix.length));
    const tranche = this.#tranches[trancheNumber - 1];
    if (tranche === undefined || tranche.status !== "submitting") {
      throw new Error(`intent ${intentId} is not currently submitting`);
    }
    return tranche;
  }

  #expireRemaining(): void {
    for (const tranche of this.#tranches) {
      if (tranche.status === "planned") {
        tranche.status = "expired";
      }
    }
  }

  #status(): SchedulerStatus {
    if (this.#tranches.every((tranche) => tranche.status === "dispatched")) {
      return "completed";
    }
    if (this.#tranches.some((tranche) => tranche.status === "expired")) {
      return "expired";
    }
    return "active";
  }
}
