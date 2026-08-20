import { stableHash } from "../core/canonical.js";

export type LaunchCodeIdentityTier = "NON_EMPTY_OBSERVED" | "PROFILE_ALLOWLISTED";

export const BOUNDED_CANARY_POLICY = Object.freeze({
  policyId: "clockin-bounded-canary-v1",
  maximumPrincipalUsdMicros: 5_000_000n,
  maximumAttemptsPerLaunch: 1,
  minimumCodeIdentityTier: "NON_EMPTY_OBSERVED" as const,
  expansionCodeIdentityTier: "PROFILE_ALLOWLISTED" as const,
  requireCanonicalCanaryEffectForExpansion: true,
  requireExecutableExitForExpansion: true,
  primaryQuoteRoute: "NATIVE_ETH" as const,
  optionalQuoteRoute: "ERC20_PERMIT" as const,
  optionalQuoteRouteBlocksNativeReadiness: false,
});

export const BOUNDED_CANARY_POLICY_HASH = stableHash({
  ...BOUNDED_CANARY_POLICY,
  maximumPrincipalUsdMicros: BOUNDED_CANARY_POLICY.maximumPrincipalUsdMicros.toString(),
});

/** Current quoted-path risk decision. The bounded canary policy remains for legacy adapters. */
export const FIRST_BUYABLE_BURST_POLICY = Object.freeze({
  policyId: "clockin-first-buyable-burst-v1",
  laneCount: 10,
  principalUsdMicrosPerLane: 5_000_000n,
  aggregatePrincipalUsdMicros: 50_000_000n,
  allInRiskCapUsdMicros: 60_000_000n,
  maximumBuyTaxBps: 5_000,
  bufferTaxBps: 9_999,
  identityAnchor: "EXACT_FACTORY_APPROVED_CREATOR_FIRST_PRIMARY_EVENT" as const,
  metadataAuthority: "AUDIT_ONLY" as const,
  executionMode: "FIRST_BUYABLE_ALL_TEN" as const,
  graduatedPolicy: "NO_SHOT" as const,
});

export const FIRST_BUYABLE_BURST_POLICY_HASH = stableHash({
  ...FIRST_BUYABLE_BURST_POLICY,
  principalUsdMicrosPerLane: FIRST_BUYABLE_BURST_POLICY.principalUsdMicrosPerLane.toString(),
  aggregatePrincipalUsdMicros: FIRST_BUYABLE_BURST_POLICY.aggregatePrincipalUsdMicros.toString(),
  allInRiskCapUsdMicros: FIRST_BUYABLE_BURST_POLICY.allInRiskCapUsdMicros.toString(),
});

export interface EntryExpansionEvidence {
  readonly codeIdentityTier: LaunchCodeIdentityTier;
  readonly canonicalCanaryEffect: boolean;
  readonly executableExitReady: boolean;
  readonly laterWalletsReady: boolean;
  readonly fullDependenciesReady: boolean;
}

export interface EntryExpansionDecision {
  readonly ready: boolean;
  readonly reasons: readonly string[];
}

export function assertBoundedCanaryPrincipal(principalUsdMicros: bigint): void {
  if (principalUsdMicros <= 0n) throw new RangeError("bounded canary principal must be positive");
  if (principalUsdMicros > BOUNDED_CANARY_POLICY.maximumPrincipalUsdMicros) {
    throw new RangeError("bounded canary principal exceeds the immutable 5U maximum");
  }
}

export function evaluateEntryExpansion(evidence: EntryExpansionEvidence): EntryExpansionDecision {
  const reasons: string[] = [];
  if (evidence.codeIdentityTier !== BOUNDED_CANARY_POLICY.expansionCodeIdentityTier) {
    reasons.push("token and pool runtime code are not profile-allowlisted");
  }
  if (!evidence.canonicalCanaryEffect) {
    reasons.push("canonical canary economic effect is not confirmed");
  }
  if (!evidence.executableExitReady) {
    reasons.push("no current executable exit capability is ready");
  }
  if (!evidence.laterWalletsReady) {
    reasons.push("wallets for lanes 2-10 are not fully funded with clean nonces");
  }
  if (!evidence.fullDependenciesReady) {
    reasons.push("full executor dependencies are not ready");
  }
  return Object.freeze({ ready: reasons.length === 0, reasons: Object.freeze(reasons) });
}
