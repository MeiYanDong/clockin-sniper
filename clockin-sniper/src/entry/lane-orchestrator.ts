import { CanonicalInvariantError, stableHash } from "../core/canonical.js";
import type { IdentityLevel } from "../identity/authorization.js";
import type { FeeBandPlan } from "./fee-band-planner.js";
import type { PoolObservation } from "./pool-observation.js";
import type { QuoteSnapshot } from "./quote-policy.js";

export type CatchUpPolicy = "ONE_PER_BLOCK" | "ALL_ELIGIBLE" | "QUOTE_RANKED_BOUNDED";
export type CapPolicy = "STRICT_5U" | "SHRINK_TO_CAP";
export type LaneExecutionState =
  | "WAITING"
  | "DEFERRED"
  | "INCOMPATIBLE_5U_CAP"
  | "DISPATCHED"
  | "UNKNOWN"
  | "FAILED_FINAL"
  | "EFFECT_CONFIRMED"
  | "EXPIRED";

export interface LaneDispatchDecision {
  readonly laneId: string;
  readonly walletId: string;
  readonly trancheNumber: number;
  readonly principalRaw: bigint;
  readonly targetFeeBps: number;
  readonly observedFeeBps: number;
  readonly observationId: string;
  readonly quoteId?: string;
  readonly reason: string;
}

export interface LaneOrchestratorConfig {
  readonly batchPrincipalRaw: bigint;
  readonly minimumShrunkPrincipalRaw: bigint;
  readonly aggregatePrincipalCapRaw: bigint;
  readonly catchUpPolicy: CatchUpPolicy;
  readonly maxConcurrentCatchUpLanes: number;
  readonly capPolicy: CapPolicy;
}

interface MutableLane {
  readonly laneId: string;
  readonly walletId: string;
  readonly trancheNumber: number;
  readonly targetFeeBps: number;
  state: LaneExecutionState;
  dispatchedPrincipalRaw: bigint;
  reason: string;
}

export class TenLaneOrchestrator {
  readonly configHash: string;
  readonly #config: LaneOrchestratorConfig;
  readonly #lanes: MutableLane[];
  #lastBlockNumber: bigint | null = null;
  #lastBlockHash: string | null = null;
  #canaryCalibrated = false;
  #stopUnsent = false;
  #laterLaneExecutionReady = false;
  #laterLaneExecutionReason = "full deployment gate has not been evaluated";
  #lastGlobalDispatchTimestamp: bigint | null = null;

  constructor(plan: FeeBandPlan, config: LaneOrchestratorConfig) {
    if (plan.lanes.length !== 10) throw new RangeError("ten fee lanes are required");
    if (config.batchPrincipalRaw <= 0n) throw new RangeError("batch principal must be positive");
    if (
      config.minimumShrunkPrincipalRaw <= 0n ||
      config.minimumShrunkPrincipalRaw > config.batchPrincipalRaw
    ) {
      throw new RangeError("minimum shrunk principal must be positive and no greater than batch");
    }
    if (config.batchPrincipalRaw * 10n > config.aggregatePrincipalCapRaw) {
      throw new CanonicalInvariantError(
        "BUDGET_EXCEEDED",
        "ten configured lane principals exceed aggregate budget",
      );
    }
    if (
      !Number.isSafeInteger(config.maxConcurrentCatchUpLanes) ||
      config.maxConcurrentCatchUpLanes < 1
    ) {
      throw new RangeError("max concurrent catch-up lanes must be positive");
    }
    this.#config = Object.freeze({ ...config });
    this.configHash = stableHash({
      ...config,
      batchPrincipalRaw: config.batchPrincipalRaw.toString(),
      minimumShrunkPrincipalRaw: config.minimumShrunkPrincipalRaw.toString(),
      aggregatePrincipalCapRaw: config.aggregatePrincipalCapRaw.toString(),
    });
    this.#lanes = plan.lanes.map((lane) => ({
      laneId: lane.laneId,
      walletId: lane.walletId,
      trancheNumber: lane.trancheNumber,
      targetFeeBps: lane.targetFeeBps,
      state: "WAITING",
      dispatchedPrincipalRaw: 0n,
      reason: "awaiting fee eligibility",
    }));
  }

  applyCanaryCalibration(stopUnsentLanes: boolean): void {
    this.#canaryCalibrated = !stopUnsentLanes;
    this.#stopUnsent = stopUnsentLanes;
  }

  setLaterLaneExecutionReadiness(ready: boolean, reason: string): void {
    const normalized = reason.trim();
    if (!ready && normalized.length === 0) {
      throw new TypeError("a blocked later-lane gate requires a reason");
    }
    this.#laterLaneExecutionReady = ready;
    this.#laterLaneExecutionReason = ready ? "full deployment gate is ready" : normalized;
  }

  deferDispatchedLane(laneId: string, reason: string): void {
    const lane = this.#lanes.find((candidate) => candidate.laneId === laneId);
    if (lane === undefined) throw new Error(`lane ${laneId} is unknown`);
    if (lane.state !== "DISPATCHED") {
      throw new Error(`lane ${laneId} cannot be deferred from ${lane.state}`);
    }
    lane.state = "DEFERRED";
    lane.dispatchedPrincipalRaw = 0n;
    lane.reason = reason;
  }

  recordLaneOutcome(
    laneId: string,
    outcome: "UNKNOWN" | "REVERTED" | "EFFECT_CONFIRMED",
    reason: string,
  ): void {
    const lane = this.#lanes.find((candidate) => candidate.laneId === laneId);
    if (lane === undefined) throw new Error(`lane ${laneId} is unknown`);
    if (lane.state !== "DISPATCHED" && lane.state !== "UNKNOWN") {
      throw new Error(`lane ${laneId} cannot record ${outcome} from ${lane.state}`);
    }
    lane.state = outcome === "REVERTED" ? "FAILED_FINAL" : outcome;
    lane.reason = reason;
  }

  restoreLane(input: {
    readonly laneId: string;
    readonly state: Extract<
      LaneExecutionState,
      "DISPATCHED" | "UNKNOWN" | "FAILED_FINAL" | "EFFECT_CONFIRMED"
    >;
    readonly dispatchedPrincipalRaw: bigint;
    readonly reason: string;
  }): void {
    const lane = this.#lanes.find((candidate) => candidate.laneId === input.laneId);
    if (lane === undefined) throw new Error(`lane ${input.laneId} is unknown`);
    if (lane.state !== "WAITING") throw new Error(`lane ${input.laneId} was already restored`);
    if (input.dispatchedPrincipalRaw <= 0n) {
      throw new RangeError("restored lane principal must be positive");
    }
    const alreadyDispatched = this.#lanes.reduce(
      (total, candidate) => total + candidate.dispatchedPrincipalRaw,
      0n,
    );
    if (alreadyDispatched + input.dispatchedPrincipalRaw > this.#config.aggregatePrincipalCapRaw) {
      throw new CanonicalInvariantError(
        "BUDGET_EXCEEDED",
        "restored lanes exceed the aggregate principal cap",
      );
    }
    lane.state = input.state;
    lane.dispatchedPrincipalRaw = input.dispatchedPrincipalRaw;
    lane.reason = input.reason;
  }

  observe(
    observation: PoolObservation,
    identityLevel: IdentityLevel,
    quotes: ReadonlyMap<string, QuoteSnapshot>,
  ): readonly LaneDispatchDecision[] {
    if (this.#lastBlockNumber !== null) {
      if (observation.block.blockNumber < this.#lastBlockNumber) return [];
      if (
        observation.block.blockNumber === this.#lastBlockNumber &&
        observation.block.blockHash.toLowerCase() === this.#lastBlockHash?.toLowerCase()
      ) {
        return [];
      }
      if (observation.block.blockNumber === this.#lastBlockNumber) {
        throw new Error(
          "same block number arrived with a different hash; reorg reconciliation required",
        );
      }
    }
    this.#lastBlockNumber = observation.block.blockNumber;
    this.#lastBlockHash = observation.block.blockHash;

    if (!observation.inWindow || this.#stopUnsent) {
      for (const lane of this.#lanes) {
        if (lane.state !== "DISPATCHED") {
          lane.state = "EXPIRED";
          lane.reason = this.#stopUnsent ? "canary stopped unsent lanes" : "fee window ended";
        }
      }
      return [];
    }
    if (observation.cooldownScope === "GLOBAL" && this.#lastGlobalDispatchTimestamp !== null) {
      const nextAllowed = this.#lastGlobalDispatchTimestamp + BigInt(observation.cooldownSeconds);
      if (observation.block.blockTimestamp < nextAllowed) return [];
    }

    const eligible = this.#lanes.filter((lane) => {
      if (
        lane.state === "DISPATCHED" ||
        lane.state === "UNKNOWN" ||
        lane.state === "FAILED_FINAL" ||
        lane.state === "EFFECT_CONFIRMED" ||
        lane.state === "EXPIRED"
      )
        return false;
      if (
        lane.trancheNumber === 1 &&
        identityLevel !== "L2" &&
        identityLevel !== "L3" &&
        identityLevel !== "L4"
      ) {
        lane.reason = "lane 1 requires L2 identity";
        return false;
      }
      if (
        lane.trancheNumber > 1 &&
        (!this.#canaryCalibrated || (identityLevel !== "L3" && identityLevel !== "L4"))
      ) {
        lane.reason = "later lanes require calibrated canary and L3 identity";
        return false;
      }
      if (lane.trancheNumber > 1 && !this.#laterLaneExecutionReady) {
        lane.reason = `later lanes require full deployment readiness: ${this.#laterLaneExecutionReason}`;
        return false;
      }
      return observation.currentFeeBps <= lane.targetFeeBps;
    });

    const quoteIsValid = (laneId: string): boolean => {
      const quote = quotes.get(laneId);
      return (
        quote !== undefined &&
        quote.profileRevision === observation.profileRevision &&
        quote.poolObservationId === observation.observationId &&
        quote.blockNumber === observation.block.blockNumber &&
        quote.blockHash.toLowerCase() === observation.block.blockHash.toLowerCase() &&
        quote.expiresAtMs >= Number(observation.block.blockTimestamp * 1_000n)
      );
    };
    const quotable = eligible.filter(
      (lane) => lane.trancheNumber === 1 || quoteIsValid(lane.laneId),
    );
    let selected: MutableLane[];
    if (this.#config.catchUpPolicy === "ALL_ELIGIBLE") {
      selected = quotable;
    } else if (this.#config.catchUpPolicy === "QUOTE_RANKED_BOUNDED") {
      selected = [...quotable]
        .sort((left, right) => {
          const leftOut = quotes.get(left.laneId)?.expectedTokenOutRaw ?? 0n;
          const rightOut = quotes.get(right.laneId)?.expectedTokenOutRaw ?? 0n;
          return leftOut === rightOut
            ? left.trancheNumber - right.trancheNumber
            : leftOut > rightOut
              ? -1
              : 1;
        })
        .slice(0, this.#config.maxConcurrentCatchUpLanes);
    } else {
      selected = quotable.slice(0, 1);
    }

    const selectedIds = new Set(selected.map((lane) => lane.laneId));
    for (const lane of eligible) {
      if (!selectedIds.has(lane.laneId)) {
        lane.state = "DEFERRED";
        lane.reason = quoteIsValid(lane.laneId)
          ? "catch-up concurrency policy deferred this eligible lane"
          : "QUOTE_UNAVAILABLE: lane deferred or bounded to one-per-block fallback";
      }
    }

    const decisions: LaneDispatchDecision[] = [];
    let remainingObservedGlobalCapRaw =
      observation.capScope === "GLOBAL" ? observation.capRaw : null;
    for (const lane of selected) {
      let principalRaw = this.#config.batchPrincipalRaw;
      const observedLegalCapRaw = remainingObservedGlobalCapRaw ?? observation.capRaw;
      if (observation.capScope !== "UNKNOWN" && principalRaw > observedLegalCapRaw) {
        if (this.#config.capPolicy === "STRICT_5U") {
          lane.state = "INCOMPATIBLE_5U_CAP";
          lane.reason = "5U principal exceeds current legal cap";
          continue;
        }
        principalRaw = observedLegalCapRaw;
      }
      if (principalRaw < this.#config.minimumShrunkPrincipalRaw) {
        lane.state = "INCOMPATIBLE_5U_CAP";
        lane.reason = "current legal cap is below the minimum non-dust lane principal";
        continue;
      }
      const quote = quotes.get(lane.laneId);
      if (
        lane.trancheNumber > 1 &&
        quoteIsValid(lane.laneId) &&
        quote?.principalRaw !== principalRaw
      ) {
        lane.state = "DEFERRED";
        lane.reason = "QUOTE_PRINCIPAL_MISMATCH: shrunk lane requires a fresh same-principal quote";
        continue;
      }
      const alreadyDispatched = this.#lanes.reduce(
        (total, item) => total + item.dispatchedPrincipalRaw,
        0n,
      );
      if (alreadyDispatched + principalRaw > this.#config.aggregatePrincipalCapRaw) {
        throw new CanonicalInvariantError(
          "BUDGET_EXCEEDED",
          "dispatch would exceed aggregate budget",
        );
      }
      lane.state = "DISPATCHED";
      lane.dispatchedPrincipalRaw = principalRaw;
      lane.reason = "fee, identity, canary, deployment, quote and cap eligible";
      decisions.push(
        Object.freeze({
          laneId: lane.laneId,
          walletId: lane.walletId,
          trancheNumber: lane.trancheNumber,
          principalRaw,
          targetFeeBps: lane.targetFeeBps,
          observedFeeBps: observation.currentFeeBps,
          observationId: observation.observationId,
          ...(quote === undefined ? {} : { quoteId: quote.quoteId }),
          reason: lane.reason,
        }),
      );
      if (remainingObservedGlobalCapRaw !== null) {
        remainingObservedGlobalCapRaw -= principalRaw;
      }
    }
    if (decisions.length > 0 && observation.cooldownScope === "GLOBAL") {
      this.#lastGlobalDispatchTimestamp = observation.block.blockTimestamp;
    }
    return Object.freeze(decisions);
  }

  snapshot(): readonly Readonly<MutableLane>[] {
    return Object.freeze(this.#lanes.map((lane) => Object.freeze({ ...lane })));
  }
}
