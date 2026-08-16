import { getAddress } from "ethers";

import {
  CanonicalInvariantError,
  stableHash,
  type LaunchCandidate,
  type LaunchIdentity,
} from "../core/canonical.js";
import type { WalletLane } from "../core/canonical.js";

export interface ClockInIdentityPolicy {
  readonly expectedNames: readonly string[];
  readonly expectedSymbols: readonly string[];
  readonly expectedCreators: readonly `0x${string}`[];
  readonly metadataIncludes: readonly string[];
  readonly tokenSuffixes: readonly string[];
  readonly requireCreator: boolean;
  readonly requireMetadata: boolean;
  readonly requireTokenSuffix: boolean;
  readonly policyRevision: number;
}

export interface IdentityEvaluation {
  readonly candidateMatch: boolean;
  readonly clockInBound: boolean;
  readonly reasons: readonly string[];
  readonly policyHash: string;
}

export function normalizeIdentityText(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[\s_-]+/g, "");
}

export function evaluateClockInIdentity(
  candidate: LaunchCandidate,
  policy: ClockInIdentityPolicy,
): IdentityEvaluation {
  const reasons: string[] = [];
  const nameMatch = policy.expectedNames
    .map(normalizeIdentityText)
    .includes(normalizeIdentityText(candidate.name));
  const symbolMatch = policy.expectedSymbols
    .map(normalizeIdentityText)
    .includes(normalizeIdentityText(candidate.symbol));
  if (!nameMatch) reasons.push("NAME_MISMATCH");
  if (!symbolMatch) reasons.push("SYMBOL_MISMATCH");

  const creatorMatch = policy.expectedCreators.some(
    (creator) => getAddress(creator).toLowerCase() === candidate.creator.toLowerCase(),
  );
  const metadataMatch = policy.metadataIncludes.some((needle) =>
    candidate.metadataUri.toLowerCase().includes(needle.toLowerCase()),
  );
  const suffixMatch = policy.tokenSuffixes.some((suffix) =>
    candidate.tokenAddress.toLowerCase().endsWith(suffix.toLowerCase()),
  );
  if (policy.requireCreator && !creatorMatch) reasons.push("CREATOR_MISMATCH");
  if (policy.requireMetadata && !metadataMatch) reasons.push("METADATA_MISMATCH");
  if (policy.requireTokenSuffix && !suffixMatch) reasons.push("TOKEN_SUFFIX_MISMATCH");

  const candidateMatch = nameMatch && symbolMatch;
  return Object.freeze({
    candidateMatch,
    clockInBound: candidateMatch && reasons.length === 0,
    reasons: Object.freeze(reasons),
    policyHash: stableHash(policy),
  });
}

export interface FreezeIdentityInput {
  readonly candidate: LaunchCandidate;
  readonly policy: ClockInIdentityPolicy;
  readonly tokenRuntimeCodeHash: `0x${string}`;
  readonly poolRuntimeCodeHash: `0x${string}`;
  readonly mechanismProfileId: string;
  readonly configHash: string;
  readonly frozenAt: string;
}

export function freezeLaunchIdentity(input: FreezeIdentityInput): LaunchIdentity {
  const evaluation = evaluateClockInIdentity(input.candidate, input.policy);
  if (!evaluation.clockInBound) {
    throw new CanonicalInvariantError(
      "IDENTITY_INCOMPLETE",
      `candidate is not ClockIn-bound: ${evaluation.reasons.join(",")}`,
    );
  }
  const launchId = `launch:${stableHash({
    chainId: 4663,
    factoryProfileId: input.candidate.factoryProfileId,
    transactionHash: input.candidate.transactionHash,
    logIndex: input.candidate.logIndex,
    tokenAddress: input.candidate.tokenAddress,
    poolAddress: input.candidate.poolAddress,
  })}`;
  return Object.freeze({
    ...input.candidate,
    launchId,
    tokenRuntimeCodeHash: input.tokenRuntimeCodeHash,
    poolRuntimeCodeHash: input.poolRuntimeCodeHash,
    mechanismProfileId: input.mechanismProfileId,
    identityPolicyHash: evaluation.policyHash,
    configHash: input.configHash,
    frozenAt: input.frozenAt,
    state: "FROZEN",
  });
}

export function reconcileOfficialCa(
  identity: LaunchIdentity,
  officialAddress: string,
): "CONFIRMED" | "IDENTITY_CONFLICT" {
  return getAddress(officialAddress).toLowerCase() === identity.tokenAddress.toLowerCase()
    ? "CONFIRMED"
    : "IDENTITY_CONFLICT";
}

export function markIdentityForReorg(identity: LaunchIdentity): LaunchIdentity {
  return Object.freeze({
    ...identity,
    revision: identity.revision + 1,
    state: "REORG_RECONCILE",
  });
}

export interface CaReconciliationDecision {
  readonly caState: "CONFIRMED" | "IDENTITY_CONFLICT";
  readonly identity: LaunchIdentity;
  readonly laneStates: readonly Readonly<{ laneId: string; state: WalletLane["state"] }>[];
  readonly entryEnabled: boolean;
  readonly exitEnabled: true;
}

export function applyOfficialCaGate(
  identity: LaunchIdentity,
  officialAddress: string,
  lanes: readonly WalletLane[],
): CaReconciliationDecision {
  const caState = reconcileOfficialCa(identity, officialAddress);
  if (caState === "CONFIRMED") {
    return Object.freeze({
      caState,
      identity,
      laneStates: Object.freeze(
        lanes.map((lane) => Object.freeze({ laneId: lane.laneId, state: lane.state })),
      ),
      entryEnabled: true,
      exitEnabled: true,
    });
  }
  const cannotCancel = new Set<WalletLane["state"]>([
    "SIGNED",
    "BROADCASTING",
    "UNKNOWN",
    "EFFECT_CONFIRMED",
    "FAILED_FINAL",
    "EXPIRED",
  ]);
  return Object.freeze({
    caState,
    identity: Object.freeze({
      ...identity,
      revision: identity.revision + 1,
      state: "IDENTITY_CONFLICT",
    }),
    laneStates: Object.freeze(
      lanes.map((lane) =>
        Object.freeze({
          laneId: lane.laneId,
          state: cannotCancel.has(lane.state) ? lane.state : ("EXPIRED" as const),
        }),
      ),
    ),
    entryEnabled: false,
    exitEnabled: true,
  });
}
