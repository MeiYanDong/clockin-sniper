import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  evaluateReconcilerRetention,
  RECONCILER_EXECUTOR_STARTUP_GRACE_MS,
} from "../src/reconciler-service.js";
import {
  emptyProductionServiceStatus,
  type ProductionServiceReadback,
  type ProductionServiceState,
} from "../src/runtime/service-status.js";

const STARTED_AT = Date.parse("2026-08-20T00:00:00.000Z");

function currentExecutor(state: ProductionServiceState): ProductionServiceReadback {
  return Object.freeze({
    state: "CURRENT",
    ageMs: 0,
    status: Object.freeze({
      ...emptyProductionServiceStatus({
        service: "executor",
        state,
        ownerId: "executor-test",
        sequence: 1,
        now: new Date(STARTED_AT).toISOString(),
      }),
      state,
    }),
  });
}

describe("reconciler paid-runtime retention", () => {
  it("allows a conservative two-minute paid executor cold start", () => {
    assert.equal(RECONCILER_EXECUTOR_STARTUP_GRACE_MS, 120_000);
  });

  it("keeps UNKNOWN/INCLUDED recovery alive after the executor terminates", () => {
    assert.deepEqual(
      evaluateReconcilerRetention({
        recoverableAttemptCount: 2,
        executor: currentExecutor("STOPPING"),
        startedAtMs: STARTED_AT,
        nowMs: STARTED_AT + RECONCILER_EXECUTOR_STARTUP_GRACE_MS + 1,
      }),
      { keepRunning: true, reason: "RECOVERABLE_ATTEMPTS_PENDING" },
    );
  });

  it("bounds the executor startup race and exits only once an idle executor is absent", () => {
    const missing: ProductionServiceReadback = Object.freeze({
      state: "MISSING",
      reason: "executor status is missing",
    });
    assert.deepEqual(
      evaluateReconcilerRetention({
        recoverableAttemptCount: 0,
        executor: missing,
        startedAtMs: STARTED_AT,
        nowMs: STARTED_AT + RECONCILER_EXECUTOR_STARTUP_GRACE_MS - 1,
      }),
      { keepRunning: true, reason: "EXECUTOR_STARTUP_GRACE" },
    );
    assert.deepEqual(
      evaluateReconcilerRetention({
        recoverableAttemptCount: 0,
        executor: currentExecutor("ACTIVE"),
        startedAtMs: STARTED_AT,
        nowMs: STARTED_AT + RECONCILER_EXECUTOR_STARTUP_GRACE_MS,
      }),
      { keepRunning: true, reason: "EXECUTOR_RUNNING" },
    );
    assert.deepEqual(
      evaluateReconcilerRetention({
        recoverableAttemptCount: 0,
        executor: currentExecutor("STOPPING"),
        startedAtMs: STARTED_AT,
        nowMs: STARTED_AT + RECONCILER_EXECUTOR_STARTUP_GRACE_MS,
      }),
      { keepRunning: false, reason: "EXECUTOR_TERMINATED_EMPTY" },
    );
    assert.deepEqual(
      evaluateReconcilerRetention({
        recoverableAttemptCount: 0,
        executor: missing,
        startedAtMs: STARTED_AT,
        nowMs: STARTED_AT + RECONCILER_EXECUTOR_STARTUP_GRACE_MS,
      }),
      { keepRunning: false, reason: "EXECUTOR_ABSENT_AFTER_GRACE" },
    );
  });

  it("does not claim a database lease that the reconciler never acquires", async () => {
    const source = await readFile(new URL("../src/reconciler-service.ts", import.meta.url), "utf8");
    assert.match(source, /leaseOwned: false/u);
    assert.doesNotMatch(source, /leaseOwned: true/u);
  });
});
