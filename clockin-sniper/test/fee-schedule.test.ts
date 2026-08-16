import assert from "node:assert/strict";
import test from "node:test";

import {
  USD_MICROS_PER_USD,
  buildFeeSchedule,
  estimateScheduleCost,
  formatUsdMicros,
} from "../src/index.js";

const baseConfig = Object.freeze({
  startFeeBps: 4_000,
  floorFeeBps: 100,
  batchCount: 10,
  windowDurationMs: 120_000,
  grossUsdMicrosPerBatch: 5n * USD_MICROS_PER_USD,
});

test("builds ten inclusive pool-fee bands from 40% to the 1% base fee", () => {
  const schedule = buildFeeSchedule(baseConfig);

  assert.deepEqual(
    schedule.map((band) => band.targetFeeBps),
    [4_000, 3_567, 3_133, 2_700, 2_267, 1_833, 1_400, 967, 533, 100],
  );
  assert.deepEqual(
    schedule.map((band) => band.referenceOffsetMs),
    [0, 13_333, 26_667, 40_000, 53_333, 66_667, 80_000, 93_333, 106_667, 120_000],
  );
  assert.ok(schedule.every((band) => band.grossUsdMicros === 5_000_000n));
});

test("can model an explicit zero floor without making it the production default", () => {
  const schedule = buildFeeSchedule({ ...baseConfig, floorFeeBps: 0 });

  assert.deepEqual(
    schedule.map((band) => band.targetFeeBps),
    [4_000, 3_556, 3_111, 2_667, 2_222, 1_778, 1_333, 889, 444, 0],
  );
});

test("estimates 50U gross and 10.25U total pool fee for a linear 40%-1% plan", () => {
  const estimate = estimateScheduleCost(buildFeeSchedule(baseConfig));

  assert.equal(estimate.grossUsdMicros, 50_000_000n);
  assert.equal(estimate.dynamicFeeUsdMicros, 10_250_000n);
  assert.equal(estimate.curveInputAfterFeeUsdMicros, 39_750_000n);
  assert.equal(estimate.averageFeeBps, 2_050);
  assert.equal(formatUsdMicros(estimate.curveInputAfterFeeUsdMicros), "39.75U");
});

test("rejects invalid schedules", () => {
  assert.throws(() => buildFeeSchedule({ ...baseConfig, batchCount: 1 }), /batchCount/);
  assert.throws(() => buildFeeSchedule({ ...baseConfig, floorFeeBps: 4_001 }), /floorFeeBps/);
});
