import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateRuntimeIdentityGate } from "../src/v2-index.js";

describe("runtime identity gate", () => {
  it("treats an official CA mismatch as a terminal veto in every mode", () => {
    for (const gateMode of ["STRICT_CA", "HYBRID_CA_GATE", "FACTORY_FULL"] as const) {
      assert.deepEqual(
        evaluateRuntimeIdentityGate({
          officialCaState: "mismatch",
          gateMode,
          canaryEffectConfirmed: true,
          strongOnchainBindingReady: true,
        }),
        {
          identityLevel: "L2",
          stopUnsent: true,
          reason: "OFFICIAL_CA_MISMATCH",
        },
      );
    }
  });

  it("requires a canonical canary effect before any independent signal can produce L3", () => {
    assert.deepEqual(
      evaluateRuntimeIdentityGate({
        officialCaState: "confirmed",
        gateMode: "HYBRID_CA_GATE",
        canaryEffectConfirmed: false,
        strongOnchainBindingReady: true,
      }),
      {
        identityLevel: "L2",
        stopUnsent: false,
        reason: "CANARY_EFFECT_PENDING",
      },
    );
  });

  it("promotes a confirmed official CA plus canonical canary effect to L3", () => {
    assert.deepEqual(
      evaluateRuntimeIdentityGate({
        officialCaState: "confirmed",
        gateMode: "STRICT_CA",
        canaryEffectConfirmed: true,
        strongOnchainBindingReady: false,
      }),
      {
        identityLevel: "L3",
        stopUnsent: false,
        reason: "OFFICIAL_CA_CONFIRMED",
      },
    );
  });

  it("allows HYBRID and FACTORY_FULL to use a strong binding while official CA is pending", () => {
    for (const gateMode of ["HYBRID_CA_GATE", "FACTORY_FULL"] as const) {
      assert.deepEqual(
        evaluateRuntimeIdentityGate({
          officialCaState: "pending",
          gateMode,
          canaryEffectConfirmed: true,
          strongOnchainBindingReady: true,
        }),
        {
          identityLevel: "L3",
          stopUnsent: false,
          reason: "STRONG_ONCHAIN_BINDING_CONFIRMED",
        },
      );
    }
  });

  it("keeps STRICT_CA at L2 while the official announcement is pending", () => {
    assert.deepEqual(
      evaluateRuntimeIdentityGate({
        officialCaState: "pending",
        gateMode: "STRICT_CA",
        canaryEffectConfirmed: true,
        strongOnchainBindingReady: true,
      }),
      {
        identityLevel: "L2",
        stopUnsent: false,
        reason: "STRICT_CA_CONFIRMATION_PENDING",
      },
    );
  });

  it("keeps a hybrid gate at L2 until either independent source is ready", () => {
    assert.deepEqual(
      evaluateRuntimeIdentityGate({
        officialCaState: "pending",
        gateMode: "HYBRID_CA_GATE",
        canaryEffectConfirmed: true,
        strongOnchainBindingReady: false,
      }),
      {
        identityLevel: "L2",
        stopUnsent: false,
        reason: "INDEPENDENT_CONFIRMATION_PENDING",
      },
    );
  });
});
