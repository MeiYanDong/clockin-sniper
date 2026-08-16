import {
  CanonicalInvariantError,
  stableHash,
  type AuthorizationRecord,
} from "../core/canonical.js";

export type IdentityLevel = "L0" | "L1" | "L2" | "L3" | "L4";
export type CaGateMode = "STRICT_CA" | "FACTORY_FULL" | "HYBRID_CA_GATE";

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
  readonly scope: unknown;
  readonly riskEnvelope: unknown;
  readonly issuedAt: string;
  readonly expiresAt: string;
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
    })}`,
    strategyId: input.strategyId,
    revision: 1,
    level: input.identityLevel,
    mode: input.source === "OPERATOR" ? "MANUAL_ARM" : "AUTO_POLICY",
    actorRef: input.source.toLowerCase(),
    policyId: input.gateMode.toLowerCase(),
    policyVersion: "1",
    scopeHash,
    riskEnvelopeHash,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    evidenceIds: Object.freeze([...input.evidenceIds]),
    reason: `lane ${input.laneNumber} authorized at ${input.identityLevel}`,
  });
}
