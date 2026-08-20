import type { CaGateMode, IdentityLevel } from "../identity/authorization.js";
import type { OfficialCaState } from "../official-ca-monitor.js";

export type RuntimeIdentityLevel = Extract<IdentityLevel, "L2" | "L3">;

export type RuntimeIdentityGateReason =
  | "OFFICIAL_CA_MISMATCH"
  | "OFFICIAL_CA_MISMATCH_AUDIT_ONLY"
  | "OFFICIAL_CA_CONFIRMED"
  | "STRONG_ONCHAIN_BINDING_CONFIRMED"
  | "CANARY_EFFECT_PENDING"
  | "STRICT_CA_CONFIRMATION_PENDING"
  | "INDEPENDENT_CONFIRMATION_PENDING";

export interface RuntimeIdentityGateInput {
  readonly officialCaState: OfficialCaState;
  readonly gateMode: CaGateMode;
  readonly canaryEffectConfirmed: boolean;
  readonly strongOnchainBindingReady: boolean;
}

export interface RuntimeIdentityGateDecision {
  readonly identityLevel: RuntimeIdentityLevel;
  readonly stopUnsent: boolean;
  readonly reason: RuntimeIdentityGateReason;
}

/**
 * Decides whether an already Factory-bound L2 identity may advance to L3.
 * Official CA disagreement is a terminal veto. A missing announcement is not
 * a hard dependency when the authorized gate accepts a strong on-chain binding.
 */
export function evaluateRuntimeIdentityGate(
  input: RuntimeIdentityGateInput,
): RuntimeIdentityGateDecision {
  if (input.officialCaState === "mismatch" && input.gateMode !== "FACTORY_FULL") {
    return Object.freeze({
      identityLevel: "L2",
      stopUnsent: true,
      reason: "OFFICIAL_CA_MISMATCH",
    });
  }

  if (input.gateMode === "FACTORY_FULL" && input.strongOnchainBindingReady) {
    return Object.freeze({
      identityLevel: "L3",
      stopUnsent: false,
      reason:
        input.officialCaState === "mismatch"
          ? "OFFICIAL_CA_MISMATCH_AUDIT_ONLY"
          : "STRONG_ONCHAIN_BINDING_CONFIRMED",
    });
  }

  if (!input.canaryEffectConfirmed) {
    return Object.freeze({
      identityLevel: "L2",
      stopUnsent: false,
      reason: "CANARY_EFFECT_PENDING",
    });
  }

  if (input.officialCaState === "confirmed") {
    return Object.freeze({
      identityLevel: "L3",
      stopUnsent: false,
      reason: "OFFICIAL_CA_CONFIRMED",
    });
  }

  if (
    input.strongOnchainBindingReady &&
    (input.gateMode === "HYBRID_CA_GATE" || input.gateMode === "FACTORY_FULL")
  ) {
    return Object.freeze({
      identityLevel: "L3",
      stopUnsent: false,
      reason: "STRONG_ONCHAIN_BINDING_CONFIRMED",
    });
  }

  return Object.freeze({
    identityLevel: "L2",
    stopUnsent: false,
    reason:
      input.gateMode === "STRICT_CA"
        ? "STRICT_CA_CONFIRMATION_PENDING"
        : "INDEPENDENT_CONFIRMATION_PENDING",
  });
}
