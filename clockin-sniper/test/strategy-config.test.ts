import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  freezeStrategyConfig,
  INITIAL_CLOCKIN_POLICY,
  STRATEGY_PARAMETER_SCHEMA,
} from "../src/config/strategy-config.js";

describe("versioned production strategy configuration", () => {
  it("freezes the accepted creator-first v3 owner policy", () => {
    assert.equal(INITIAL_CLOCKIN_POLICY.clockInBudgetUsdMicros, 50_000_000n);
    assert.equal(INITIAL_CLOCKIN_POLICY.allInRiskCapUsdMicros, 60_000_000n);
    assert.equal(INITIAL_CLOCKIN_POLICY.routineExitMaximumSlippageBps, 500);
    assert.equal(INITIAL_CLOCKIN_POLICY.breakGlassExitMaximumSlippageBps, 2_000);
    assert.equal(INITIAL_CLOCKIN_POLICY.authorizationMaximumTtlMs, 604_800_000);
    assert.equal(INITIAL_CLOCKIN_POLICY.productionArmable, true);
    assert.equal(INITIAL_CLOCKIN_POLICY.caGateMode, "FACTORY_FULL");
    assert.equal(INITIAL_CLOCKIN_POLICY.catchUpPolicy, "ALL_ELIGIBLE");
    assert.equal(INITIAL_CLOCKIN_POLICY.maxConcurrentCatchUpLanes, 10);
    assert.match(INITIAL_CLOCKIN_POLICY.configHash, /^sha256:/);
    assert.equal(INITIAL_CLOCKIN_POLICY.blockers.length, 0);
  });

  it("changes the immutable hash when reviewed metadata changes", () => {
    const {
      configHash: _hash,
      productionArmable: _armable,
      blockers: _blockers,
      ...base
    } = INITIAL_CLOCKIN_POLICY;
    const armed = freezeStrategyConfig({
      ...base,
      changedAt: "2026-08-16T01:00:00.000Z",
    });
    assert.equal(armed.productionArmable, true);
    assert.equal(armed.blockers.length, 0);
    assert.notEqual(armed.configHash, INITIAL_CLOCKIN_POLICY.configHash);
  });

  it("rejects budget, identity, cap or emergency-slippage drift instead of reusing v3", () => {
    const {
      configHash: _hash,
      productionArmable: _armable,
      blockers: _blockers,
      ...base
    } = INITIAL_CLOCKIN_POLICY;
    assert.throws(
      () => freezeStrategyConfig({ ...base, clockInBudgetUsdMicros: 55_000_000n }),
      /50000000/,
    );
    assert.throws(
      () => freezeStrategyConfig({ ...base, caGateMode: "HYBRID_CA_GATE" }),
      /FACTORY_FULL/,
    );
    assert.throws(() => freezeStrategyConfig({ ...base, capPolicy: "SHRINK_TO_CAP" }), /STRICT_5U/);
    assert.throws(
      () => freezeStrategyConfig({ ...base, breakGlassExitMaximumSlippageBps: 2_001 }),
      /2000/,
    );
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
