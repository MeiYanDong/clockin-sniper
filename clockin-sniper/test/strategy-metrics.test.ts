import assert from "node:assert/strict";
import { it } from "node:test";

import type { EffectRecord, ExecutionPlan } from "../src/core/canonical.js";
import { StrategyMetricsLedger } from "../src/strategies/strategy-metrics.js";
import {
  CLOCKIN_STRATEGY_ID,
  FIRST_OFFICIAL_LAUNCH_STRATEGY_ID,
} from "../src/strategies/strategy-router.js";

const NOW = "2026-08-16T00:00:00.000Z";
const ADDRESS = `0x${"1".repeat(40)}` as const;
const HASH = `0x${"2".repeat(64)}` as const;

it("keeps ClockIn and first-official-launch metrics and effects isolated", () => {
  const metrics = new StrategyMetricsLedger();
  metrics.recordRoutingDecision({
    launchId: "launch-first",
    ownerStrategyId: FIRST_OFFICIAL_LAUNCH_STRATEGY_ID,
    clockIn: "IGNORE",
    firstOfficialLaunch: "MONITOR",
    budgetId: "first:monitor-only",
    reason: "monitor only",
  });
  metrics.recordRoutingDecision({
    launchId: "launch-clockin",
    ownerStrategyId: CLOCKIN_STRATEGY_ID,
    clockIn: "EXECUTE",
    firstOfficialLaunch: "IGNORE",
    budgetId: "clockin:budget",
    reason: "ClockIn matched",
  });
  const plan: ExecutionPlan = {
    planId: "plan-1",
    planHash: "plan-hash",
    strategyId: CLOCKIN_STRATEGY_ID,
    revision: 1,
    intentId: "intent-1",
    launchId: "launch-clockin",
    laneId: "entry-01",
    validityEnvelopeId: "validity-1",
    authorizationId: "auth-1",
    factoryProfileRevision: 1,
    mechanismProfileRevision: 1,
    adapterId: "entry-v1",
    walletAddress: ADDRESS,
    nonce: "0",
    to: ADDRESS,
    valueRaw: "5000000",
    calldataHash: "calldata-hash",
    methodSelector: "0x12345678",
    observedFeeBps: 4_000,
    targetFeeBps: 4_000,
    quoteBlock: "100",
    minOutputRaw: "1",
    gasLimit: "100000",
    maxFeePerGasRaw: "10",
    maxPriorityFeePerGasRaw: "1",
    capitalReservationId: "reservation-1",
    evidenceIds: ["quote-1"],
    state: "FROZEN",
    createdAt: NOW,
    frozenAt: NOW,
  };
  metrics.recordExecutionPlan(plan);
  const known = <T>(value: T) =>
    Object.freeze({ state: "KNOWN" as const, value, observedAt: NOW, evidenceIds: ["receipt-1"] });
  const effect: EffectRecord = {
    effectId: "effect-1",
    strategyId: CLOCKIN_STRATEGY_ID,
    revision: 1,
    intentId: "intent-1",
    attemptId: "attempt-1",
    launchId: "launch-clockin",
    laneId: "entry-01",
    side: "ENTRY",
    result: "SUCCESS",
    canonicality: "CANONICAL",
    txHash: HASH,
    blockNumber: known("101"),
    blockHash: known(HASH),
    transactionIndex: known("0"),
    assetDeltas: known([]),
    principalDeltaRaw: known("5000000"),
    tokenDeltaRaw: known("100"),
    gasCostRaw: known("10"),
    declaredFeeBps: known(4_000),
    actualOutputRaw: known("100"),
    settlement: "RESIDUAL_POSITION",
    positionLotIds: ["lot-1"],
    evidenceIds: ["receipt-1"],
    observedAt: NOW,
  };
  metrics.recordEffect(effect);

  assert.deepEqual(metrics.snapshot(FIRST_OFFICIAL_LAUNCH_STRATEGY_ID), {
    strategyId: FIRST_OFFICIAL_LAUNCH_STRATEGY_ID,
    routingDecisions: 1,
    executionPlans: 0,
    canonicalEffects: 0,
    failedEffects: 0,
    actualPrincipalRaw: 0n,
  });
  assert.equal(metrics.snapshot(CLOCKIN_STRATEGY_ID).actualPrincipalRaw, 5_000_000n);
  assert.equal(metrics.snapshot(CLOCKIN_STRATEGY_ID).canonicalEffects, 1);
});
