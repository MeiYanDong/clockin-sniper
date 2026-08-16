import assert from "node:assert/strict";
import test from "node:test";

import {
  ClockInSniperEngine,
  FeeTrancheScheduler,
  USD_MICROS_PER_USD,
  buildFeeSchedule,
  type ClockInPlanConfig,
  type SubmissionResult,
  type TrancheIntent,
  type TrancheSubmitter,
} from "../src/index.js";

const config: ClockInPlanConfig = Object.freeze({
  launchId: "clockin-test-launch",
  windowStartedAtMs: 1_000_000,
  windowDurationMs: 120_000,
  startFeeBps: 4_000,
  floorFeeBps: 0,
  batchCount: 10,
  grossUsdMicrosPerBatch: 5n * USD_MICROS_PER_USD,
});

const accepted = (intent: TrancheIntent): SubmissionResult =>
  Object.freeze({ state: "accepted", attemptId: `attempt-${intent.trancheNumber}` });

test("starts only when external buying is allowed and the fee band is reached", () => {
  const scheduler = new FeeTrancheScheduler(config);

  assert.equal(
    scheduler.claimNext({
      observedAtMs: config.windowStartedAtMs,
      blockNumber: 10n,
      feeBps: 4_000,
      externalBuyAllowed: false,
    }),
    null,
  );
  assert.equal(
    scheduler.claimNext({
      observedAtMs: config.windowStartedAtMs,
      blockNumber: 11n,
      feeBps: 4_001,
      externalBuyAllowed: true,
    }),
    null,
  );

  const intent = scheduler.claimNext({
    observedAtMs: config.windowStartedAtMs + 1,
    blockNumber: 12n,
    feeBps: 3_999,
    externalBuyAllowed: true,
  });
  assert.equal(intent?.trancheNumber, 1);
  assert.equal(intent?.grossUsdMicros, 5_000_000n);
});

test("catches up one fixed tranche per new block when several bands were crossed", () => {
  const scheduler = new FeeTrancheScheduler(config);

  const first = scheduler.claimNext({
    observedAtMs: config.windowStartedAtMs + 10,
    blockNumber: 20n,
    feeBps: 0,
    externalBuyAllowed: true,
  });
  assert.ok(first);
  scheduler.markSubmitted(first.intentId, accepted(first));

  assert.equal(
    scheduler.claimNext({
      observedAtMs: config.windowStartedAtMs + 11,
      blockNumber: 20n,
      feeBps: 0,
      externalBuyAllowed: true,
    }),
    null,
  );

  const second = scheduler.claimNext({
    observedAtMs: config.windowStartedAtMs + 12,
    blockNumber: 21n,
    feeBps: 0,
    externalBuyAllowed: true,
  });
  assert.equal(second?.trancheNumber, 2);
});

test("ignores duplicate and out-of-order block observations", () => {
  const scheduler = new FeeTrancheScheduler(config);
  const first = scheduler.claimNext({
    observedAtMs: config.windowStartedAtMs,
    blockNumber: 25n,
    feeBps: 0,
    externalBuyAllowed: true,
  });
  assert.ok(first);
  scheduler.markSubmitted(first.intentId, accepted(first));

  for (const blockNumber of [25n, 24n]) {
    assert.equal(
      scheduler.claimNext({
        observedAtMs: config.windowStartedAtMs + 1,
        blockNumber,
        feeBps: 0,
        externalBuyAllowed: true,
      }),
      null,
    );
  }

  const second = scheduler.claimNext({
    observedAtMs: config.windowStartedAtMs + 2,
    blockNumber: 26n,
    feeBps: 0,
    externalBuyAllowed: true,
  });
  assert.equal(second?.trancheNumber, 2);
});

test("retries a transport error on a later block without changing intent identity", async () => {
  const scheduler = new FeeTrancheScheduler(config);
  let calls = 0;
  const submitter: TrancheSubmitter = {
    async submit(intent) {
      calls += 1;
      if (calls === 1) {
        throw new Error("route unavailable");
      }
      return accepted(intent);
    },
  };
  const engine = new ClockInSniperEngine(scheduler, submitter);

  const first = await engine.observe({
    observedAtMs: config.windowStartedAtMs,
    blockNumber: 30n,
    feeBps: 4_000,
    externalBuyAllowed: true,
  });
  assert.equal(first?.kind, "transport_error");

  const retry = await engine.observe({
    observedAtMs: config.windowStartedAtMs + 1,
    blockNumber: 31n,
    feeBps: 4_000,
    externalBuyAllowed: true,
  });
  assert.equal(retry?.kind, "submitted");
  assert.equal(retry?.intent.intentId, "clockin-test-launch:tranche:1");
  assert.equal(retry?.intent.attemptNumber, 2);
});

test("does not claim a duplicate while submission is in flight", async () => {
  const scheduler = new FeeTrancheScheduler(config);
  let release: ((result: SubmissionResult) => void) | undefined;
  const pending = new Promise<SubmissionResult>((resolve) => {
    release = resolve;
  });
  const engine = new ClockInSniperEngine(scheduler, { submit: async () => pending });

  const firstObservation = engine.observe({
    observedAtMs: config.windowStartedAtMs,
    blockNumber: 40n,
    feeBps: 4_000,
    externalBuyAllowed: true,
  });
  const duplicate = await engine.observe({
    observedAtMs: config.windowStartedAtMs + 1,
    blockNumber: 41n,
    feeBps: 0,
    externalBuyAllowed: true,
  });

  assert.equal(duplicate, null);
  assert.ok(release);
  release({ state: "unknown", attemptId: "attempt-unknown" });
  const first = await firstObservation;
  assert.equal(first?.kind, "submitted");
  assert.equal(first?.submission.state, "unknown");

  const next = await engine.observe({
    observedAtMs: config.windowStartedAtMs + 2,
    blockNumber: 42n,
    feeBps: 0,
    externalBuyAllowed: true,
  });
  assert.equal(next?.intent.trancheNumber, 2);
});

test("dispatches all ten 5U tranches across the fee schedule", async () => {
  const scheduler = new FeeTrancheScheduler(config);
  const submitted: TrancheIntent[] = [];
  const engine = new ClockInSniperEngine(scheduler, {
    async submit(intent) {
      submitted.push(intent);
      return accepted(intent);
    },
  });

  for (const band of buildFeeSchedule(config)) {
    await engine.observe({
      observedAtMs: config.windowStartedAtMs + band.referenceOffsetMs,
      blockNumber: 100n + BigInt(band.trancheNumber),
      feeBps: band.targetFeeBps,
      externalBuyAllowed: true,
    });
  }

  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.submittedBatchCount, 10);
  assert.equal(snapshot.submittedUsdMicros, 50_000_000n);
  assert.deepEqual(
    submitted.map((intent) => intent.trancheNumber),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
});

test("expires unsent tranches after the two-minute window", () => {
  const scheduler = new FeeTrancheScheduler(config);

  assert.equal(
    scheduler.claimNext({
      observedAtMs: config.windowStartedAtMs + config.windowDurationMs + 1,
      blockNumber: 999n,
      feeBps: 0,
      externalBuyAllowed: true,
    }),
    null,
  );
  assert.equal(scheduler.snapshot().status, "expired");
  assert.ok(scheduler.snapshot().tranches.every((tranche) => tranche.status === "expired"));
});

test("can explicitly close the schedule when a polling loop reaches its deadline", () => {
  const scheduler = new FeeTrancheScheduler(config);

  assert.equal(scheduler.expireAt(config.windowStartedAtMs + config.windowDurationMs), false);
  assert.equal(scheduler.expireAt(config.windowStartedAtMs + config.windowDurationMs + 1), true);
  assert.equal(scheduler.snapshot().status, "expired");
});

test("uses Factory identity for tranche one, official CA for later tranches, and pool cooldown", () => {
  const scheduler = new FeeTrancheScheduler({
    ...config,
    floorFeeBps: 100,
    minimumTrancheIntervalMs: 20_000,
    chainAuthorizedTrancheCount: 1,
  });
  const first = scheduler.claimNext({
    observedAtMs: config.windowStartedAtMs,
    blockNumber: 1n,
    feeBps: 4_000,
    externalBuyAllowed: true,
    officialCaConfirmed: false,
  });
  assert.ok(first);
  scheduler.markSubmitted(first.intentId, accepted(first));

  assert.equal(
    scheduler.claimNext({
      observedAtMs: config.windowStartedAtMs + 10_000,
      blockNumber: 2n,
      feeBps: 3_500,
      externalBuyAllowed: true,
      officialCaConfirmed: true,
    }),
    null,
  );
  assert.equal(
    scheduler.claimNext({
      observedAtMs: config.windowStartedAtMs + 20_000,
      blockNumber: 3n,
      feeBps: 3_500,
      externalBuyAllowed: true,
      officialCaConfirmed: false,
    }),
    null,
  );
  const second = scheduler.claimNext({
    observedAtMs: config.windowStartedAtMs + 20_000,
    blockNumber: 4n,
    feeBps: 3_500,
    externalBuyAllowed: true,
    officialCaConfirmed: true,
  });
  assert.equal(second?.trancheNumber, 2);
  assert.equal(second?.earliestDispatchOffsetMs, 20_000);
  assert.equal(scheduler.snapshot().expiresAtMs, config.windowStartedAtMs + 200_000);
});
