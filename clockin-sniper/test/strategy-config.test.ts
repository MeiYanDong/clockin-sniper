import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  freezeStrategyConfig,
  INITIAL_CLOCKIN_POLICY,
  STRATEGY_PARAMETER_SCHEMA,
} from "../src/config/strategy-config.js";

describe("versioned production strategy configuration", () => {
  it("freezes accepted parameters and exposes every unresolved production blocker", () => {
    assert.equal(INITIAL_CLOCKIN_POLICY.clockInBudgetUsdMicros, 50_000_000n);
    assert.equal(INITIAL_CLOCKIN_POLICY.productionArmable, false);
    assert.match(INITIAL_CLOCKIN_POLICY.configHash, /^sha256:/);
    assert.equal(INITIAL_CLOCKIN_POLICY.blockers.length, 6);
  });

  it("becomes armable only after every owner-controlled bound is explicit", () => {
    const {
      configHash: _hash,
      productionArmable: _armable,
      blockers: _blockers,
      ...base
    } = INITIAL_CLOCKIN_POLICY;
    const armed = freezeStrategyConfig({
      ...base,
      revision: 2,
      priceMaximumAgeMs: 30_000,
      priceMaximumDeviationBps: 100,
      maximumHoldingMs: 3_600_000,
      momentumFailurePolicyId: "momentum-v1",
      initialStopLossBps: 2_000,
      manualExitMaximumSlippageBps: 500,
      changedAt: "2026-08-16T01:00:00.000Z",
    });
    assert.equal(armed.productionArmable, true);
    assert.equal(armed.blockers.length, 0);
    assert.notEqual(armed.configHash, INITIAL_CLOCKIN_POLICY.configHash);
  });

  it("rejects a budget, identity or cap policy change instead of silently reusing v1", () => {
    const {
      configHash: _hash,
      productionArmable: _armable,
      blockers: _blockers,
      ...base
    } = INITIAL_CLOCKIN_POLICY;
    assert.throws(
      () => freezeStrategyConfig({ ...base, clockInBudgetUsdMicros: 55_000_000n }),
      /50U/,
    );
    assert.throws(
      () => freezeStrategyConfig({ ...base, caGateMode: "FACTORY_FULL" }),
      /HYBRID_CA_GATE/,
    );
    assert.throws(() => freezeStrategyConfig({ ...base, capPolicy: "SHRINK_TO_CAP" }), /strict 5U/);
  });

  it("assigns an owner, default, range and change control to every production parameter", () => {
    const {
      configHash: _hash,
      productionArmable: _armable,
      blockers: _blockers,
      ...productionConfig
    } = INITIAL_CLOCKIN_POLICY;
    const actualKeys = STRATEGY_PARAMETER_SCHEMA.map((definition) => definition.key).sort();
    const expectedKeys = Object.keys(productionConfig).sort();
    assert.deepEqual(actualKeys, expectedKeys);
    assert.equal(new Set(actualKeys).size, expectedKeys.length);
    for (const definition of STRATEGY_PARAMETER_SCHEMA) {
      assert.ok(definition.owner.length > 0);
      assert.ok(definition.allowed.length > 0);
      assert.match(definition.changeControl, /config hash/);
    }
  });
});
