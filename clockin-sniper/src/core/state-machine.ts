import { CanonicalInvariantError, type ReasonCode } from "./canonical.js";

export type TransitionMap<State extends string> = Readonly<Record<State, readonly State[]>>;

export function assertTransition<State extends string>(
  transitions: TransitionMap<State>,
  from: State,
  to: State,
  reasonCode: ReasonCode = "STATE_TRANSITION_INVALID",
): void {
  if (!transitions[from].includes(to)) {
    throw new CanonicalInvariantError(reasonCode, `invalid state transition ${from} -> ${to}`);
  }
}

export const walletLaneTransitions = Object.freeze({
  UNALLOCATED: ["CAPITAL_RESERVED", "EXPIRED"],
  CAPITAL_RESERVED: ["IDENTITY_ELIGIBLE", "EXPIRED"],
  IDENTITY_ELIGIBLE: ["FEE_ELIGIBLE", "EXPIRED"],
  FEE_ELIGIBLE: ["PLAN_FROZEN", "EXPIRED"],
  PLAN_FROZEN: ["SIGNED", "EXPIRED"],
  SIGNED: ["BROADCASTING", "UNKNOWN"],
  BROADCASTING: ["UNKNOWN", "EFFECT_CONFIRMED", "FAILED_FINAL"],
  UNKNOWN: ["BROADCASTING", "EFFECT_CONFIRMED", "FAILED_FINAL"],
  EFFECT_CONFIRMED: [],
  FAILED_FINAL: [],
  EXPIRED: [],
} as const);

export const factoryProfileTransitions = Object.freeze({
  OBSERVED: ["FINGERPRINTED", "QUARANTINED"],
  FINGERPRINTED: ["PROFILE_MATCHED", "QUARANTINED"],
  PROFILE_MATCHED: ["VERIFIED", "QUARANTINED"],
  VERIFIED: ["HOT_ARMED", "STALE_REVERIFY_REQUIRED", "QUARANTINED"],
  HOT_ARMED: ["STALE_REVERIFY_REQUIRED", "QUARANTINED"],
  QUARANTINED: ["FINGERPRINTED"],
  STALE_REVERIFY_REQUIRED: ["FINGERPRINTED", "QUARANTINED"],
} as const);
