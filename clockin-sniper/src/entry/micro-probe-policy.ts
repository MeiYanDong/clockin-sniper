import {
  CanonicalInvariantError,
  stableHash,
  type AuthorizationRecord,
  type EntryIntent,
} from "../core/canonical.js";

export interface MicroProbePolicyConfig {
  readonly enabled: boolean;
  readonly maximumPrincipalUsdMicros: bigint;
  readonly strategyId: string;
  readonly budgetId: string;
  readonly walletId: string;
}

export class BoundedMicroProbePolicy {
  readonly #config: MicroProbePolicyConfig;
  readonly #claimedLaunches = new Set<string>();

  constructor(config: MicroProbePolicyConfig) {
    if (config.maximumPrincipalUsdMicros <= 0n || config.maximumPrincipalUsdMicros > 250_000n) {
      throw new RangeError("micro probe principal must be positive and at most 0.25U");
    }
    if (config.strategyId === "clockin-mainnet-v1") {
      throw new Error("micro probe must use a strategy isolated from the ClockIn 50U budget");
    }
    this.#config = Object.freeze({ ...config });
  }

  createIntent(input: {
    launchId: string;
    opportunityId: string;
    laneId: string;
    validityEnvelopeId: string;
    targetKey: string;
    authorization: AuthorizationRecord;
    evidenceIds: readonly string[];
    createdAt: string;
  }): EntryIntent {
    if (!this.#config.enabled) {
      throw new CanonicalInvariantError(
        "AUTHORIZATION_SCOPE_MISMATCH",
        "bounded micro probe is disabled by default",
      );
    }
    if (input.authorization.mode !== "MANUAL_ARM") {
      throw new CanonicalInvariantError(
        "AUTHORIZATION_SCOPE_MISMATCH",
        "micro probe requires a separate explicit operator authorization",
      );
    }
    if (this.#claimedLaunches.has(input.launchId)) {
      throw new CanonicalInvariantError(
        "BUDGET_EXCEEDED",
        "at most one bounded micro probe is allowed per trusted launch",
      );
    }
    this.#claimedLaunches.add(input.launchId);
    return Object.freeze({
      intentId: `micro-probe:${stableHash({
        strategyId: this.#config.strategyId,
        budgetId: this.#config.budgetId,
        walletId: this.#config.walletId,
        launchId: input.launchId,
      })}`,
      strategyId: this.#config.strategyId,
      revision: 1,
      opportunityId: input.opportunityId,
      launchId: input.launchId,
      laneId: input.laneId,
      validityEnvelopeId: input.validityEnvelopeId,
      targetKey: input.targetKey,
      maxInputRaw: this.#config.maximumPrincipalUsdMicros.toString(),
      authorizationId: input.authorization.authorizationId,
      evidenceIds: Object.freeze([...input.evidenceIds]),
      createdAt: input.createdAt,
      side: "ENTRY",
      action: "PROBE",
      trancheNumber: 1,
    });
  }
}
