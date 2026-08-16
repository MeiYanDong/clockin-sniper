import {
  CanonicalInvariantError,
  stableHash,
  type AuthorizationRecord,
} from "../core/canonical.js";

export type IdentityLevel = "L0" | "L1" | "L2" | "L3" | "L4";
export type CaGateMode = "STRICT_CA" | "FACTORY_FULL" | "HYBRID_CA_GATE";

export const MAXIMUM_AUTHORIZATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface ProductionAuthorizationScope {
  readonly chainId: 4663;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly strategyConfigHash: string;
  readonly walletIds: readonly string[];
  readonly identityGate: CaGateMode;
}

export interface ProductionRiskEnvelope {
  readonly clockInBudgetUsdMicros: "50000000";
  readonly allInRiskCapUsdMicros: "60000000";
  readonly maximumLaneUsdMicros: "5000000";
  readonly minimumLaneUsdMicros: "1000000";
  readonly routineExitMaximumSlippageBps: 500;
  readonly breakGlassExitMaximumSlippageBps: 2000;
}

const levelRank: Readonly<Record<IdentityLevel, number>> = Object.freeze({
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
});

export interface AuthorizationInput {
  readonly strategyId: string;
  readonly laneNumber: number;
  readonly identityLevel: IdentityLevel;
  readonly gateMode: CaGateMode;
  readonly officialCaConfirmed: boolean;
  readonly preapprovedStrongBinding: boolean;
  readonly source: "DETERMINISTIC_POLICY" | "OPERATOR" | "AI_CANDIDATE";
  readonly scope: ProductionAuthorizationScope;
  readonly riskEnvelope: ProductionRiskEnvelope;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly maximumTtlMs: number;
  readonly evidenceIds: readonly string[];
}

export function authorizeEntryLane(input: AuthorizationInput): AuthorizationRecord {
  if (!Number.isSafeInteger(input.laneNumber) || input.laneNumber < 1 || input.laneNumber > 10) {
    throw new RangeError("laneNumber must be between 1 and 10");
  }
  if (input.source === "AI_CANDIDATE") {
    throw new CanonicalInvariantError(
      "IDENTITY_INCOMPLETE",
      "AI candidate evidence cannot elevate live authorization",
    );
  }
  if (
    input.scope.chainId !== 4663 ||
    input.scope.profileId.trim().length === 0 ||
    !Number.isSafeInteger(input.scope.profileRevision) ||
    input.scope.profileRevision < 1 ||
    input.scope.strategyConfigHash.trim().length === 0 ||
    input.scope.identityGate !== input.gateMode ||
    input.scope.walletIds.length < 1 ||
    input.scope.walletIds.length > 10 ||
    input.scope.walletIds.some((walletId) => walletId.trim().length === 0) ||
    new Set(input.scope.walletIds).size !== input.scope.walletIds.length
  ) {
    throw new CanonicalInvariantError(
      "IDENTITY_INCOMPLETE",
      "authorization scope must bind chain, profile, config, unique wallets and identity gate",
    );
  }
  if (
    input.riskEnvelope.clockInBudgetUsdMicros !== "50000000" ||
    input.riskEnvelope.allInRiskCapUsdMicros !== "60000000" ||
    input.riskEnvelope.maximumLaneUsdMicros !== "5000000" ||
    input.riskEnvelope.minimumLaneUsdMicros !== "1000000" ||
    input.riskEnvelope.routineExitMaximumSlippageBps !== 500 ||
    input.riskEnvelope.breakGlassExitMaximumSlippageBps !== 2_000
  ) {
    throw new CanonicalInvariantError(
      "BUDGET_EXCEEDED",
      "authorization risk envelope does not match ClockIn policy v2",
    );
  }
  if (
    !Number.isSafeInteger(input.maximumTtlMs) ||
    input.maximumTtlMs <= 0 ||
    input.maximumTtlMs > MAXIMUM_AUTHORIZATION_TTL_MS
  ) {
    throw new RangeError("authorization maximum TTL must be positive and no longer than 7 days");
  }
  const issuedAtMs = Date.parse(input.issuedAt);
  const expiresAtMs = Date.parse(input.expiresAt);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) {
    throw new TypeError("authorization timestamps must be valid ISO-8601 values");
  }
  if (expiresAtMs <= issuedAtMs) {
    throw new RangeError("authorization expiry must be after issuance");
  }
  if (expiresAtMs - issuedAtMs > input.maximumTtlMs) {
    throw new RangeError("authorization exceeds its maximum TTL");
  }
  const requiredLevel: IdentityLevel = input.laneNumber === 1 ? "L2" : "L3";
  let independentlyConfirmed = input.officialCaConfirmed || input.preapprovedStrongBinding;
  if (input.gateMode === "STRICT_CA" && input.laneNumber > 1) {
    independentlyConfirmed = input.officialCaConfirmed;
  }
  if (input.gateMode === "FACTORY_FULL" && input.identityLevel === "L2") {
    independentlyConfirmed = true;
  }
  if (
    levelRank[input.identityLevel] < levelRank[requiredLevel] ||
    (input.laneNumber > 1 && !independentlyConfirmed)
  ) {
    throw new CanonicalInvariantError(
      "IDENTITY_INCOMPLETE",
      `lane ${input.laneNumber} requires ${requiredLevel} independent identity confirmation`,
    );
  }
  const scopeHash = stableHash(input.scope);
  const riskEnvelopeHash = stableHash(input.riskEnvelope);
  return Object.freeze({
    authorizationId: `authorization:${stableHash({
      strategyId: input.strategyId,
      laneNumber: input.laneNumber,
      scopeHash,
      riskEnvelopeHash,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      maximumTtlMs: input.maximumTtlMs,
    })}`,
    strategyId: input.strategyId,
    revision: 1,
    level: input.identityLevel,
    mode: input.source === "OPERATOR" ? "MANUAL_ARM" : "AUTO_POLICY",
    actorRef: input.source.toLowerCase(),
    policyId: input.gateMode.toLowerCase(),
    policyVersion: "2",
    scopeHash,
    riskEnvelopeHash,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    evidenceIds: Object.freeze([...input.evidenceIds]),
    reason: `lane ${input.laneNumber} authorized at ${input.identityLevel}`,
  });
}
