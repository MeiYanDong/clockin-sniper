import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertDirectEoaEntryPath } from "../src/adapters/protocol-contracts.js";
import { CanonicalInvariantError, type LaunchIdentity } from "../src/core/canonical.js";
import {
  assertBoundedCanaryPrincipal,
  BOUNDED_CANARY_POLICY,
  BOUNDED_CANARY_POLICY_HASH,
  evaluateEntryExpansion,
  FIRST_BUYABLE_BURST_POLICY_HASH,
} from "../src/entry/bounded-canary-policy.js";
import { prepareCanaryInParallel } from "../src/entry/canary-preparation.js";
import {
  assertCanarySnapshotMatchesPlan,
  createCanaryInputSnapshot,
  reconcileCanary,
  StatefulFrictionEstimator,
  type CanaryEffectInput,
} from "../src/entry/canary-estimator.js";
import { planTenFeeBands, planTenFirstBuyableBurst } from "../src/entry/fee-band-planner.js";
import {
  freezeQuoteBoundedEntryPlan,
  type EntryPlanDraft,
} from "../src/entry/execution-plan-builder.js";
import { TenLaneOrchestrator } from "../src/entry/lane-orchestrator.js";
import { BoundedMicroProbePolicy } from "../src/entry/micro-probe-policy.js";
import {
  assertProviderBlockAgreement,
  observePoolAt,
  type PoolObservation,
  type PoolReadAdapter,
} from "../src/entry/pool-observation.js";
import {
  createQuoteSnapshot,
  quoteBoundedMinOut,
  reviseQuoteSnapshot,
  speedCanaryMinOut,
  type QuoteSnapshot,
} from "../src/entry/quote-policy.js";

const HASH_A = `0x${"11".repeat(32)}` as const;
const HASH_B = `0x${"22".repeat(32)}` as const;
const ADDRESS = `0x${"33".repeat(20)}` as const;

function plan(start = 4_000, floor = 0) {
  return planTenFeeBands(
    start,
    floor,
    Array.from({ length: 10 }, (_, index) => `wallet-${index + 1}`),
    Array.from({ length: 10 }, (_, index) => `reservation-${index + 1}`),
  );
}

function observation(overrides: Partial<PoolObservation> = {}): PoolObservation {
  return {
    observationId: "observation-1",
    profileRevision: 1,
    block: { blockNumber: 100n, blockHash: HASH_A, blockTimestamp: 1_000n },
    currentFeeBps: 4_000,
    inWindow: true,
    capRaw: 5_000n,
    capScope: "PER_WALLET",
    cooldownSeconds: 0,
    cooldownScope: "PER_WALLET",
    eoaOnlyActive: true,
    quoteAsset: ADDRESS,
    curveStateHash: "curve-1",
    evidenceIds: ["evidence-1"],
    ...overrides,
  };
}

function quote(
  laneId: string,
  tokenOut: bigint,
  blockNumber = 100n,
  blockHash: `0x${string}` = HASH_A,
  poolObservationId = "observation-1",
  principalRaw = 5_000n,
): QuoteSnapshot {
  return createQuoteSnapshot({
    laneId,
    poolObservationId,
    profileRevision: 1,
    blockNumber,
    blockHash,
    principalRaw,
    expectedTokenOutRaw: tokenOut,
    observedAtMs: 1_000_000,
    expiresAtMs: 2_000_000,
    evidenceIds: ["quote-evidence"],
  });
}

describe("ten fee-band planner", () => {
  it("covers the exact 40% to 0% and 40% to 1% endpoints", () => {
    assert.deepEqual(
      plan().lanes.map((lane) => lane.targetFeeBps),
      [4_000, 3_556, 3_111, 2_667, 2_222, 1_778, 1_333, 889, 444, 0],
    );
    assert.deepEqual(
      plan(4_000, 100).lanes.map((lane) => lane.targetFeeBps),
      [4_000, 3_567, 3_133, 2_700, 2_267, 1_833, 1_400, 967, 533, 100],
    );
  });

  it("keeps endpoints, monotonicity, unique lanes and exactly 50U across many inputs", () => {
    for (let start = 100; start <= 10_000; start += 137) {
      const floor = Math.floor(start / 7);
      const result = plan(start, floor);
      assert.equal(result.lanes.length, 10);
      assert.equal(result.lanes[0]?.targetFeeBps, start);
      assert.equal(result.lanes[9]?.targetFeeBps, floor);
      assert.equal(new Set(result.lanes.map((lane) => lane.walletId)).size, 10);
      assert.equal(new Set(result.lanes.map((lane) => lane.reservationId)).size, 10);
      assert.equal(
        result.lanes.reduce((sum, lane) => sum + lane.nominalUsdMicros, 0n),
        50_000_000n,
      );
      for (let index = 1; index < result.lanes.length; index += 1) {
        assert.ok(
          (result.lanes[index - 1]?.targetFeeBps ?? -1) >=
            (result.lanes[index]?.targetFeeBps ?? -1),
        );
      }
    }
  });

  it("rejects duplicate wallet or reservation ownership", () => {
    assert.throws(
      () =>
        planTenFeeBands(
          4_000,
          0,
          Array.from({ length: 10 }, () => "same-wallet"),
          Array.from({ length: 10 }, (_, index) => `reservation-${index}`),
        ),
      /unique/,
    );
  });

  it("freezes all ten 5U lanes at the same first-buyable tax", () => {
    const burst = planTenFirstBuyableBurst(
      5_000,
      Array.from({ length: 10 }, (_, index) => `wallet-${index + 1}`),
      Array.from({ length: 10 }, (_, index) => `reservation-${index + 1}`),
    );
    assert.deepEqual(
      burst.lanes.map((lane) => lane.targetFeeBps),
      Array.from({ length: 10 }, () => 5_000),
    );
    assert.equal(
      burst.lanes.reduce((total, lane) => total + lane.nominalUsdMicros, 0n),
      50_000_000n,
    );
    assert.match(FIRST_BUYABLE_BURST_POLICY_HASH, /^sha256:/u);
  });
});

describe("exact-block observation and quote validity", () => {
  it("reads every mechanism field at the exact requested block", async () => {
    const seen: bigint[] = [];
    const adapter: PoolReadAdapter = {
      adapterId: "fixture-adapter",
      readBlock: async (blockNumber) => {
        seen.push(blockNumber);
        return { blockNumber, blockHash: HASH_A, blockTimestamp: 1_000n };
      },
      readFeeBps: async (blockNumber) => {
        seen.push(blockNumber);
        return 3_500;
      },
      readWindow: async (blockNumber) => {
        seen.push(blockNumber);
        return true;
      },
      readCap: async (blockNumber) => {
        seen.push(blockNumber);
        return { value: 5_000n, scope: "PER_WALLET" };
      },
      readCooldown: async (blockNumber) => {
        seen.push(blockNumber);
        return { seconds: 10, scope: "PER_WALLET" };
      },
      readEoaOnly: async (blockNumber) => {
        seen.push(blockNumber);
        return true;
      },
      readQuoteAsset: async (blockNumber) => {
        seen.push(blockNumber);
        return ADDRESS;
      },
      readCurveStateHash: async (blockNumber) => {
        seen.push(blockNumber);
        return "curve";
      },
    };
    const result = await observePoolAt(adapter, 7, 123n, ["evidence"]);
    assert.equal(result.block.blockNumber, 123n);
    assert.equal(result.profileRevision, 7);
    assert.deepEqual(
      seen,
      Array.from({ length: 8 }, () => 123n),
    );
  });

  it("accepts the zero address as the canonical native ETH quote asset", async () => {
    const adapter: PoolReadAdapter = {
      adapterId: "native-eth-adapter",
      readBlock: async (blockNumber) => ({
        blockNumber,
        blockHash: HASH_A,
        blockTimestamp: 1_000n,
      }),
      readFeeBps: async () => 4_000,
      readWindow: async () => true,
      readCap: async () => ({ value: 5_000n, scope: "PER_WALLET" }),
      readCooldown: async () => ({ seconds: 0, scope: "NONE" }),
      readEoaOnly: async () => true,
      readQuoteAsset: async () => "0x0000000000000000000000000000000000000000",
      readCurveStateHash: async () => "native-curve",
    };
    const result = await observePoolAt(adapter, 1, 100n, ["native-quote-evidence"]);
    assert.equal(result.quoteAsset, "0x0000000000000000000000000000000000000000");
  });

  it("fails closed on impossible state and provider split brain", async () => {
    const adapter: PoolReadAdapter = {
      adapterId: "bad-adapter",
      readBlock: async (blockNumber) => ({
        blockNumber,
        blockHash: HASH_A,
        blockTimestamp: 1_000n,
      }),
      readFeeBps: async () => 10_001,
      readWindow: async () => true,
      readCap: async () => ({ value: 5_000n, scope: "PER_WALLET" }),
      readCooldown: async () => ({ seconds: 0, scope: "NONE" }),
      readEoaOnly: async () => true,
      readQuoteAsset: async () => ADDRESS,
      readCurveStateHash: async () => "curve",
    };
    await assert.rejects(
      () => observePoolAt(adapter, 1, 100n, []),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "POOL_STATE_INVALID",
    );
    assert.throws(
      () =>
        assertProviderBlockAgreement([
          { blockNumber: 100n, blockHash: HASH_A, blockTimestamp: 1_000n },
          { blockNumber: 100n, blockHash: HASH_B, blockTimestamp: 1_000n },
        ]),
      /split brain/,
    );
  });

  it("derives quote-bounded minOut and rejects stale or wrong-block quotes", () => {
    const snapshot = quote("clockin-entry-02", 10_000n);
    assert.equal(quoteBoundedMinOut(snapshot, 250, 1_500_000, HASH_A), 9_750n);
    assert.equal(speedCanaryMinOut(), 1n);
    assert.throws(
      () => quoteBoundedMinOut(snapshot, 250, 2_000_001, HASH_A),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "QUOTE_STALE",
    );
    assert.throws(() => quoteBoundedMinOut(snapshot, 250, 1_500_000, HASH_B), /stale/);
  });
});

describe("speed canary reconciliation", () => {
  const snapshot = createCanaryInputSnapshot({
    mechanismProfileId: "mechanism-1",
    profileRevision: 1,
    poolObservationId: "observation-1",
    parentBlockNumber: 99n,
    parentBlockHash: HASH_A,
    declaredFeeBps: 4_000,
    curveStateHash: "curve",
    grossNoFeeTokenOutRaw: 1_000n,
    protocolPreviewTokenOutRaw: 620n,
    capRaw: 5_000n,
    inWindow: true,
    quoteAsset: ADDRESS,
    principalRaw: 5_000n,
    minOutputRaw: 1n,
    sourceObservedAt: "2026-08-16T00:00:00.000Z",
    sourceExpiresAt: "2026-08-16T00:00:05.000Z",
    evidenceIds: ["input"],
  });
  const baseEffect: CanaryEffectInput = {
    receiptStatus: "SUCCESS",
    actualTokenOutRaw: 600n,
    gasCostRaw: 10n,
    principalDeltaRaw: 5_000n,
    receiptBlockNumber: 100n,
    receiptTxHash: HASH_B,
    tokenBalanceBeforeRaw: 100n,
    tokenBalanceAfterRaw: 700n,
    transferLogTokenOutRaw: 600n,
    evidenceIds: ["effect"],
  };

  it("calibrates only when receipt, balance and transfer evidence agree", () => {
    const result = reconcileCanary(snapshot, baseEffect, 500);
    assert.equal(result.state, "CALIBRATED");
    assert.equal(result.impliedTotalBuyDragBps, 4_000);
    assert.equal(result.executionDriftBps, 322);
    assert.equal(result.tokenTransferTaxBps, "UNKNOWN");
    assert.equal(result.stopUnsentLanes, false);
  });

  it("stops unsent lanes on drift, confounding or success-without-effect", () => {
    assert.equal(reconcileCanary(snapshot, baseEffect, 100).state, "DRIFTED");
    assert.equal(
      reconcileCanary(snapshot, { ...baseEffect, transferLogTokenOutRaw: 599n }, 500).state,
      "CONFOUNDED",
    );
    const noEffect = reconcileCanary(
      snapshot,
      {
        ...baseEffect,
        actualTokenOutRaw: 0n,
        tokenBalanceAfterRaw: 100n,
        transferLogTokenOutRaw: 0n,
      },
      500,
    );
    assert.equal(noEffect.state, "UNKNOWN");
    assert.equal(noEffect.stopUnsentLanes, true);
  });

  it("does not invent implied tax without an adapter no-fee reference", () => {
    const noReference = createCanaryInputSnapshot({
      mechanismProfileId: snapshot.mechanismProfileId,
      profileRevision: snapshot.profileRevision,
      poolObservationId: snapshot.poolObservationId,
      parentBlockNumber: snapshot.parentBlockNumber,
      parentBlockHash: snapshot.parentBlockHash,
      declaredFeeBps: snapshot.declaredFeeBps,
      curveStateHash: snapshot.curveStateHash,
      protocolPreviewTokenOutRaw: 620n,
      capRaw: snapshot.capRaw,
      inWindow: snapshot.inWindow,
      quoteAsset: snapshot.quoteAsset,
      principalRaw: snapshot.principalRaw,
      minOutputRaw: snapshot.minOutputRaw,
      sourceObservedAt: snapshot.sourceObservedAt,
      sourceExpiresAt: snapshot.sourceExpiresAt,
      evidenceIds: snapshot.evidenceIds,
    });
    const result = reconcileCanary(noReference, baseEffect, 500);
    assert.equal(result.impliedTotalBuyDragBps, undefined);
    assert.equal(result.curvePriceImpactBps, "UNKNOWN");
    assert.equal(result.tokenTransferTaxBps, "UNKNOWN");
  });

  it("enforces DECLARED_ONLY to PENDING to CALIBRATED to continuously updated transitions", () => {
    const estimator = new StatefulFrictionEstimator(500);
    assert.equal(estimator.snapshot().state, "DECLARED_ONLY");
    estimator.markCanaryPending(snapshot);
    assert.equal(estimator.snapshot().state, "CANARY_PENDING");
    assert.equal(estimator.reconcile(baseEffect).state, "CALIBRATED");
    assert.equal(estimator.snapshot().state, "CALIBRATED");
    assert.equal(estimator.update(snapshot, baseEffect).state, "CONTINUOUSLY_UPDATED");
    assert.equal(estimator.snapshot().state, "CONTINUOUSLY_UPDATED");
    assert.throws(() => estimator.markCanaryPending(snapshot), /cannot/);
  });

  it("decomposes transfer tax and curve impact only when adapter evidence provides both bases", () => {
    const decomposable = createCanaryInputSnapshot({
      ...snapshot,
      spotNoImpactTokenOutRaw: 1_100n,
      grossNoFeeTokenOutRaw: 1_000n,
    });
    const result = reconcileCanary(
      decomposable,
      {
        ...baseEffect,
        actualTokenOutRaw: 600n,
        tokenBalanceBeforeRaw: 100n,
        tokenBalanceAfterRaw: 700n,
        poolTokenOutBeforeTransferTaxRaw: 625n,
        transferLogTokenOutRaw: 625n,
      },
      500,
    );
    assert.equal(result.tokenTransferTaxBps, 400);
    assert.equal(result.curvePriceImpactBps, 909);
  });
});

describe("bounded canary and expansion policy", () => {
  it("caps the early-risk bypass at one 5U canary and binds a stable policy hash", () => {
    assert.equal(BOUNDED_CANARY_POLICY.maximumAttemptsPerLaunch, 1);
    assert.equal(BOUNDED_CANARY_POLICY.maximumPrincipalUsdMicros, 5_000_000n);
    assert.equal(BOUNDED_CANARY_POLICY.primaryQuoteRoute, "NATIVE_ETH");
    assert.equal(BOUNDED_CANARY_POLICY.optionalQuoteRouteBlocksNativeReadiness, false);
    assert.match(BOUNDED_CANARY_POLICY_HASH, /^sha256:/);
    assert.doesNotThrow(() => assertBoundedCanaryPrincipal(5_000_000n));
    assert.throws(() => assertBoundedCanaryPrincipal(5_000_001n), /5U maximum/);
  });

  it("requires canonical effect, allowlisted code, later wallets and exit before expansion", () => {
    const blocked = evaluateEntryExpansion({
      codeIdentityTier: "NON_EMPTY_OBSERVED",
      canonicalCanaryEffect: false,
      executableExitReady: false,
      laterWalletsReady: false,
      fullDependenciesReady: false,
    });
    assert.equal(blocked.ready, false);
    assert.equal(blocked.reasons.length, 5);
    const ready = evaluateEntryExpansion({
      codeIdentityTier: "PROFILE_ALLOWLISTED",
      canonicalCanaryEffect: true,
      executableExitReady: true,
      laterWalletsReady: true,
      fullDependenciesReady: true,
    });
    assert.deepEqual(ready, { ready: true, reasons: [] });
  });
});

describe("ten independent entry lanes", () => {
  function engine(
    catchUpPolicy:
      | "ONE_PER_BLOCK"
      | "ALL_ELIGIBLE"
      | "QUOTE_RANKED_BOUNDED" = "QUOTE_RANKED_BOUNDED",
    capPolicy: "STRICT_5U" | "SHRINK_TO_CAP" = "STRICT_5U",
    fullDeploymentReady = true,
  ) {
    const orchestrator = new TenLaneOrchestrator(plan(), {
      batchPrincipalRaw: 5_000n,
      minimumShrunkPrincipalRaw: 1_000n,
      aggregatePrincipalCapRaw: 50_000n,
      catchUpPolicy,
      maxConcurrentCatchUpLanes: 2,
      capPolicy,
    });
    if (fullDeploymentReady) {
      orchestrator.setLaterLaneExecutionReadiness(true, "fixture full deployment is ready");
    }
    return orchestrator;
  }

  it("dispatches lane 1 at L2 but gates lanes 2-10 on canary and L3", () => {
    const orchestrator = engine();
    const first = orchestrator.observe(observation(), "L2", new Map());
    assert.deepEqual(
      first.map((decision) => decision.trancheNumber),
      [1],
    );
    const blocked = orchestrator.observe(
      observation({
        observationId: "observation-2",
        block: { blockNumber: 101n, blockHash: HASH_B, blockTimestamp: 1_001n },
        currentFeeBps: 0,
      }),
      "L2",
      new Map(),
    );
    assert.equal(blocked.length, 0);
    assert.match(orchestrator.snapshot()[1]?.reason ?? "", /calibrated canary/);
  });

  it("dispatches ten quoted wallets together in creator-first burst mode", () => {
    const burstPlan = planTenFirstBuyableBurst(
      5_000,
      Array.from({ length: 10 }, (_, index) => `wallet-${index + 1}`),
      Array.from({ length: 10 }, (_, index) => `reservation-${index + 1}`),
    );
    const orchestrator = new TenLaneOrchestrator(burstPlan, {
      batchPrincipalRaw: 5_000n,
      minimumShrunkPrincipalRaw: 5_000n,
      aggregatePrincipalCapRaw: 50_000n,
      catchUpPolicy: "ALL_ELIGIBLE",
      maxConcurrentCatchUpLanes: 10,
      capPolicy: "STRICT_5U",
      requireCanaryBeforeLaterLanes: false,
      requireQuoteForCanary: true,
    });
    orchestrator.setLaterLaneExecutionReadiness(true, "all ten wallets are production-ready");
    const quotes = new Map(
      burstPlan.lanes.map((lane, index) => [
        lane.laneId,
        quote(lane.laneId, BigInt(1_000 - index)),
      ]),
    );
    const decisions = orchestrator.observe(observation({ currentFeeBps: 5_000 }), "L3", quotes);
    assert.equal(decisions.length, 10);
    assert.equal(
      decisions.reduce((total, decision) => total + decision.principalRaw, 0n),
      50_000n,
    );
    assert.deepEqual(
      decisions.map((decision) => decision.targetFeeBps),
      Array.from({ length: 10 }, () => 5_000),
    );
  });

  it("ranks catch-up quotes, bounds concurrency and never dispatches twice", () => {
    const orchestrator = engine();
    orchestrator.observe(observation(), "L2", new Map());
    orchestrator.applyCanaryCalibration(false);
    const quotes = new Map([
      ["clockin-entry-02", quote("clockin-entry-02", 900n, 101n, HASH_B, "observation-2")],
      ["clockin-entry-03", quote("clockin-entry-03", 1_100n, 101n, HASH_B, "observation-2")],
      ["clockin-entry-04", quote("clockin-entry-04", 1_000n, 101n, HASH_B, "observation-2")],
    ]);
    const next = observation({
      observationId: "observation-2",
      block: { blockNumber: 101n, blockHash: HASH_B, blockTimestamp: 1_001n },
      currentFeeBps: 0,
    });
    assert.deepEqual(
      orchestrator.observe(next, "L3", quotes).map((decision) => decision.trancheNumber),
      [3, 4],
    );
    assert.equal(orchestrator.observe(next, "L3", quotes).length, 0);
  });

  it("isolates UNKNOWN/revert outcomes to their own wallet lanes", () => {
    const orchestrator = engine("ALL_ELIGIBLE");
    const first = orchestrator.observe(observation(), "L2", new Map());
    const firstLane = first[0];
    if (firstLane === undefined) throw new Error("first lane missing");
    orchestrator.recordLaneOutcome(firstLane.laneId, "UNKNOWN", "provider timeout");
    orchestrator.applyCanaryCalibration(false);
    const nextObservation = observation({
      observationId: "observation-independent",
      block: { blockNumber: 101n, blockHash: HASH_B, blockTimestamp: 1_001n },
      currentFeeBps: 0,
    });
    const quotes = new Map(
      Array.from({ length: 9 }, (_, index) => {
        const laneId = `clockin-entry-${String(index + 2).padStart(2, "0")}`;
        return [
          laneId,
          quote(laneId, 1_000n, 101n, HASH_B, nextObservation.observationId),
        ] as const;
      }),
    );
    const later = orchestrator.observe(nextObservation, "L3", quotes);
    assert.equal(later.length, 9);
    assert.equal(orchestrator.snapshot()[0]?.state, "UNKNOWN");
    orchestrator.recordLaneOutcome(later[0]?.laneId ?? "", "REVERTED", "cap changed");
    assert.equal(orchestrator.snapshot()[1]?.state, "FAILED_FINAL");
    assert.equal(orchestrator.snapshot()[2]?.state, "DISPATCHED");
  });

  it("restores dispatched and terminal lanes after restart without creating a second intent", () => {
    const orchestrator = engine();
    orchestrator.restoreLane({
      laneId: "clockin-entry-01",
      state: "EFFECT_CONFIRMED",
      dispatchedPrincipalRaw: 5_000n,
      reason: "restored canonical receipt",
    });
    orchestrator.applyCanaryCalibration(false);
    const nextObservation = observation({
      observationId: "restart-observation",
      block: { blockNumber: 101n, blockHash: HASH_B, blockTimestamp: 1_001n },
      currentFeeBps: 3_500,
    });
    const quotes = new Map([
      ["clockin-entry-02", quote("clockin-entry-02", 900n, 101n, HASH_B, "restart-observation")],
    ]);
    assert.deepEqual(
      orchestrator.observe(nextObservation, "L3", quotes).map((decision) => decision.trancheNumber),
      [2],
    );
    assert.equal(orchestrator.snapshot()[0]?.state, "EFFECT_CONFIRMED");
    assert.throws(
      () =>
        orchestrator.restoreLane({
          laneId: "clockin-entry-01",
          state: "DISPATCHED",
          dispatchedPrincipalRaw: 5_000n,
          reason: "duplicate restore",
        }),
      /already restored/,
    );
  });

  it("defers later lanes when trustworthy exact-block quotes are absent", () => {
    const orchestrator = engine();
    orchestrator.observe(observation(), "L2", new Map());
    orchestrator.applyCanaryCalibration(false);
    const dispatched = orchestrator.observe(
      observation({
        observationId: "observation-2",
        block: { blockNumber: 101n, blockHash: HASH_B, blockTimestamp: 1_001n },
        currentFeeBps: 0,
      }),
      "L3",
      new Map(),
    );
    assert.equal(dispatched.length, 0);
    assert.match(orchestrator.snapshot()[1]?.reason ?? "", /QUOTE_UNAVAILABLE/);
    assert.equal(orchestrator.snapshot()[2]?.state, "DEFERRED");
  });

  it("keeps later lanes retryable until the full deployment gate becomes ready", () => {
    const orchestrator = engine("ONE_PER_BLOCK", "STRICT_5U", false);
    orchestrator.observe(observation(), "L2", new Map());
    orchestrator.applyCanaryCalibration(false);
    const next = observation({
      observationId: "blocked-full-deployment",
      block: { blockNumber: 101n, blockHash: HASH_B, blockTimestamp: 1_001n },
      currentFeeBps: 0,
    });
    const quotes = new Map([
      ["clockin-entry-02", quote("clockin-entry-02", 1_000n, 101n, HASH_B, next.observationId)],
    ]);
    assert.equal(orchestrator.observe(next, "L3", quotes).length, 0);
    assert.match(orchestrator.snapshot()[1]?.reason ?? "", /full deployment readiness/);

    orchestrator.setLaterLaneExecutionReadiness(true, "exit and full dependencies are ready");
    const later = observation({
      observationId: "ready-full-deployment",
      block: { blockNumber: 102n, blockHash: HASH_A, blockTimestamp: 1_002n },
      currentFeeBps: 0,
    });
    const laterQuotes = new Map([
      ["clockin-entry-02", quote("clockin-entry-02", 1_000n, 102n, HASH_A, later.observationId)],
    ]);
    const dispatched = orchestrator.observe(later, "L3", laterQuotes);
    assert.equal(dispatched[0]?.trancheNumber, 2);
    orchestrator.deferDispatchedLane("clockin-entry-02", "dependency became stale before signing");
    assert.equal(orchestrator.snapshot()[1]?.state, "DEFERRED");
    assert.equal(orchestrator.snapshot()[1]?.dispatchedPrincipalRaw, 0n);
  });

  it("implements all-eligible and one-per-block policies independently", () => {
    for (const [policy, expected] of [
      ["ONE_PER_BLOCK", 1],
      ["ALL_ELIGIBLE", 9],
    ] as const) {
      const orchestrator = engine(policy);
      orchestrator.observe(observation(), "L2", new Map());
      orchestrator.applyCanaryCalibration(false);
      const quotes = new Map(
        Array.from({ length: 9 }, (_, index) => {
          const laneId = `clockin-entry-${String(index + 2).padStart(2, "0")}`;
          return [
            laneId,
            quote(laneId, BigInt(1_000 - index), 101n, HASH_B, `observation-${policy}`),
          ] as const;
        }),
      );
      const result = orchestrator.observe(
        observation({
          observationId: `observation-${policy}`,
          block: { blockNumber: 101n, blockHash: HASH_B, blockTimestamp: 1_001n },
          currentFeeBps: 0,
        }),
        "L3",
        quotes,
      );
      assert.equal(result.length, expected);
    }
  });

  it("applies strict and shrinking cap policies without exceeding the aggregate budget", () => {
    const strict = engine("ONE_PER_BLOCK", "STRICT_5U");
    assert.equal(strict.observe(observation({ capRaw: 4_000n }), "L2", new Map()).length, 0);
    assert.equal(strict.snapshot()[0]?.state, "INCOMPATIBLE_5U_CAP");

    const shrinking = engine("ONE_PER_BLOCK", "SHRINK_TO_CAP");
    assert.equal(
      shrinking.observe(observation({ capRaw: 4_000n }), "L2", new Map())[0]?.principalRaw,
      4_000n,
    );
    assert.ok(
      shrinking.snapshot().reduce((sum, lane) => sum + lane.dispatchedPrincipalRaw, 0n) <= 50_000n,
    );
  });

  it("skips dust-sized cap remnants and never redistributes unused principal", () => {
    const shrinking = engine("ALL_ELIGIBLE", "SHRINK_TO_CAP");
    assert.equal(shrinking.observe(observation({ capRaw: 999n }), "L2", new Map()).length, 0);
    assert.equal(shrinking.snapshot()[0]?.state, "INCOMPATIBLE_5U_CAP");
    assert.equal(
      shrinking.snapshot().reduce((sum, lane) => sum + lane.dispatchedPrincipalRaw, 0n),
      0n,
    );
  });

  it("allocates a global cap once across lanes and requires a same-principal quote after shrink", () => {
    const shrinking = engine("ALL_ELIGIBLE", "SHRINK_TO_CAP");
    shrinking.observe(observation(), "L2", new Map());
    shrinking.applyCanaryCalibration(false);
    const next = observation({
      observationId: "observation-global-cap",
      block: { blockNumber: 101n, blockHash: HASH_B, blockTimestamp: 1_001n },
      currentFeeBps: 0,
      capScope: "GLOBAL",
      capRaw: 8_000n,
    });
    const quotes = new Map([
      [
        "clockin-entry-02",
        quote("clockin-entry-02", 10_000n, 101n, HASH_B, next.observationId, 5_000n),
      ],
      [
        "clockin-entry-03",
        quote("clockin-entry-03", 9_000n, 101n, HASH_B, next.observationId, 3_000n),
      ],
      ...Array.from({ length: 7 }, (_, index) => {
        const laneId = `clockin-entry-${String(index + 4).padStart(2, "0")}`;
        return [
          laneId,
          quote(laneId, 8_000n - BigInt(index), 101n, HASH_B, next.observationId, 5_000n),
        ] as const;
      }),
    ]);
    const dispatched = shrinking.observe(next, "L3", quotes);
    assert.deepEqual(
      dispatched.map((decision) => decision.principalRaw),
      [5_000n, 3_000n],
    );
    assert.equal(
      dispatched.reduce((sum, decision) => sum + decision.principalRaw, 0n),
      8_000n,
    );
  });

  it("defers a shrunk later lane when its quote was produced for nominal 5U", () => {
    const shrinking = engine("ONE_PER_BLOCK", "SHRINK_TO_CAP");
    shrinking.observe(observation(), "L2", new Map());
    shrinking.applyCanaryCalibration(false);
    const next = observation({
      observationId: "observation-shrunk-requote",
      block: { blockNumber: 101n, blockHash: HASH_B, blockTimestamp: 1_001n },
      currentFeeBps: 0,
      capRaw: 4_000n,
    });
    const quotes = new Map([
      [
        "clockin-entry-02",
        quote("clockin-entry-02", 9_000n, 101n, HASH_B, next.observationId, 5_000n),
      ],
    ]);
    assert.equal(shrinking.observe(next, "L3", quotes).length, 0);
    assert.match(shrinking.snapshot()[1]?.reason ?? "", /QUOTE_PRINCIPAL_MISMATCH/);
  });

  it("enforces cap fixtures for per-tx, per-wallet and global scopes", () => {
    for (const scope of ["PER_TX", "PER_WALLET", "GLOBAL"] as const) {
      const strict = engine("ONE_PER_BLOCK", "STRICT_5U");
      assert.equal(
        strict.observe(observation({ capRaw: 4_999n, capScope: scope }), "L2", new Map()).length,
        0,
      );
      assert.equal(strict.snapshot()[0]?.state, "INCOMPATIBLE_5U_CAP");
    }
  });

  it("deduplicates/out-orders heads, enforces global cooldown and expires the window", () => {
    const orchestrator = engine("ONE_PER_BLOCK");
    assert.equal(
      orchestrator.observe(
        observation({ cooldownScope: "GLOBAL", cooldownSeconds: 10 }),
        "L2",
        new Map(),
      ).length,
      1,
    );
    orchestrator.applyCanaryCalibration(false);
    assert.equal(
      orchestrator.observe(
        observation({
          observationId: "observation-2",
          block: { blockNumber: 101n, blockHash: HASH_B, blockTimestamp: 1_005n },
          currentFeeBps: 0,
          cooldownScope: "GLOBAL",
          cooldownSeconds: 10,
        }),
        "L3",
        new Map(),
      ).length,
      0,
    );
    assert.equal(
      orchestrator.observe(
        observation({
          observationId: "old",
          block: { blockNumber: 99n, blockHash: HASH_A, blockTimestamp: 999n },
        }),
        "L3",
        new Map(),
      ).length,
      0,
    );
    orchestrator.observe(
      observation({
        observationId: "ended",
        block: { blockNumber: 102n, blockHash: HASH_A, blockTimestamp: 1_011n },
        inWindow: false,
        currentFeeBps: 0,
      }),
      "L3",
      new Map(),
    );
    assert.ok(
      orchestrator
        .snapshot()
        .filter((lane) => lane.state !== "DISPATCHED")
        .every((lane) => lane.state === "EXPIRED"),
    );
  });
});

describe("entry template and plan immutability", () => {
  const identity: LaunchIdentity = Object.freeze({
    candidateId: "candidate-1",
    strategyId: "clockin-mainnet-v1",
    revision: 1,
    factoryProfileId: "factory-1",
    creator: ADDRESS,
    tokenAddress: `0x${"44".repeat(20)}`,
    poolAddress: `0x${"55".repeat(20)}`,
    name: "ClockIn",
    symbol: "CLOCKIN",
    metadataUri: "ipfs://clockin",
    imageHash: HASH_A,
    blockNumber: "100",
    blockHash: HASH_A,
    transactionHash: HASH_B,
    transactionIndex: "0",
    logIndex: "0",
    evidenceIds: ["launch-event"],
    observedAt: "2026-08-16T00:00:00.000Z",
    launchId: "launch-1",
    tokenRuntimeCodeHash: HASH_A,
    poolRuntimeCodeHash: HASH_B,
    mechanismProfileId: "mechanism-1",
    identityPolicyHash: "identity-hash",
    configHash: "config-hash",
    frozenAt: "2026-08-16T00:00:00.000Z",
    state: "FROZEN",
  });
  const template = {
    adapterId: "entry-v1",
    profileRevision: 1,
    walletAddress: ADDRESS,
    target: identity.poolAddress,
    valueRaw: 5_000n,
    calldata: "0x1234" as const,
    minOutputRaw: 1n,
    earliestValidBlock: 101n,
    expectedEffectAssets: [identity.tokenAddress],
  };

  it("requires a direct EOA-to-pool call during the EOA-only window", () => {
    assert.doesNotThrow(() =>
      assertDirectEoaEntryPath({
        template,
        identity,
        walletRuntimeCode: "0x",
        eoaOnlyActive: true,
      }),
    );
    assert.throws(
      () =>
        assertDirectEoaEntryPath({
          template: { ...template, target: `0x${"66".repeat(20)}` },
          identity,
          walletRuntimeCode: "0x",
          eoaOnlyActive: true,
        }),
      /directly/,
    );
    assert.throws(
      () =>
        assertDirectEoaEntryPath({
          template,
          identity,
          walletRuntimeCode: "0x6001",
          eoaOnlyActive: true,
        }),
      /empty runtime code/,
    );
  });

  it("prepares dynamic preflight and signing concurrently only at L2 and exact earliest block", async () => {
    const sequence: string[] = [];
    const prepared = await prepareCanaryInParallel({
      identityLevel: "L2",
      launchBlock: 100n,
      readPreflight: async () => {
        sequence.push("preflight-start");
        await Promise.resolve();
        sequence.push("preflight-end");
        return observation();
      },
      buildAndSign: async () => {
        sequence.push("sign-start");
        await Promise.resolve();
        sequence.push("sign-end");
        return { template, signedRaw: "0x0102" as const };
      },
    });
    assert.equal(prepared.earliestValidBlock, 101n);
    assert.deepEqual(sequence.slice(0, 2), ["preflight-start", "sign-start"]);
    await assert.rejects(
      prepareCanaryInParallel({
        identityLevel: "L1",
        launchBlock: 100n,
        readPreflight: async () => observation(),
        buildAndSign: async () => ({ template, signedRaw: "0x0102" as const }),
      }),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "IDENTITY_INCOMPLETE",
    );
  });

  it("puts minOut and quote revision into an immutable plan hash", () => {
    const firstQuote = quote("clockin-entry-02", 10_000n);
    const snapshot = createCanaryInputSnapshot({
      mechanismProfileId: "mechanism-1",
      profileRevision: 1,
      poolObservationId: "observation-1",
      parentBlockNumber: 100n,
      parentBlockHash: HASH_A,
      declaredFeeBps: 3_500,
      curveStateHash: "curve-1",
      protocolPreviewTokenOutRaw: 10_000n,
      capRaw: 5_000n,
      inWindow: true,
      quoteAsset: ADDRESS,
      principalRaw: 5_000n,
      minOutputRaw: 9_500n,
      sourceObservedAt: "2026-08-16T00:00:00.000Z",
      sourceExpiresAt: "2026-08-16T00:00:05.000Z",
      evidenceIds: ["pool-observation-1"],
    });
    const draft: EntryPlanDraft = {
      planId: "plan-2",
      strategyId: "clockin-mainnet-v1",
      revision: 1,
      intentId: "intent-2",
      launchId: "launch-1",
      laneId: "clockin-entry-02",
      validityEnvelopeId: "envelope-2",
      authorizationId: "authorization-2",
      factoryProfileRevision: 1,
      mechanismProfileRevision: 1,
      adapterId: "entry-v1",
      walletAddress: ADDRESS,
      nonce: "0",
      to: identity.poolAddress,
      valueRaw: "5000",
      calldataHash: "calldata-hash",
      methodSelector: "0x12345678",
      observedFeeBps: 3_500,
      targetFeeBps: 3_556,
      gasLimit: "100000",
      maxFeePerGasRaw: "10",
      maxPriorityFeePerGasRaw: "1",
      capitalReservationId: "reservation-2",
      evidenceIds: [firstQuote.quoteId, snapshot.snapshotId],
      createdAt: "2026-08-16T00:00:00.000Z",
    };
    const first = freezeQuoteBoundedEntryPlan({
      draft,
      quote: firstQuote,
      minOutputRaw: 9_500n,
    });
    assert.throws(
      () =>
        freezeQuoteBoundedEntryPlan({
          draft: { ...draft, valueRaw: "4000" },
          quote: firstQuote,
          minOutputRaw: 9_500n,
        }),
      /principal does not match/,
    );
    const revisedQuote = reviseQuoteSnapshot(firstQuote, {
      poolObservationId: "observation-2",
      profileRevision: 1,
      blockNumber: 101n,
      blockHash: HASH_B,
      principalRaw: 5_000n,
      expectedTokenOutRaw: 9_000n,
      observedAtMs: 1_001_000,
      expiresAtMs: 2_001_000,
      evidenceIds: ["quote-evidence-2"],
    });
    const second = freezeQuoteBoundedEntryPlan({
      draft: { ...draft, revision: 2, evidenceIds: [revisedQuote.quoteId] },
      quote: revisedQuote,
      minOutputRaw: 8_550n,
    });
    assert.equal(revisedQuote.revision, 2);
    assert.notEqual(first.planHash, second.planHash);
    assert.equal(first.minOutputRaw, "9500");
    assert.equal(second.quoteBlock, "101");
    assert.doesNotThrow(() => assertCanarySnapshotMatchesPlan(snapshot, first));
    assert.throws(
      () => assertCanarySnapshotMatchesPlan(snapshot, second),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "QUOTE_STALE",
    );
  });
});

describe("optional bounded micro probe", () => {
  const authorization = {
    authorizationId: "operator-auth",
    strategyId: "probe-v1",
    revision: 1,
    level: "L3" as const,
    mode: "MANUAL_ARM" as const,
    actorRef: "operator",
    policyId: "micro-probe",
    policyVersion: "1",
    scopeHash: "scope",
    riskEnvelopeHash: "risk",
    issuedAt: "2026-08-16T00:00:00Z",
    evidenceIds: ["operator-evidence"],
    reason: "explicit probe",
  };
  const input = {
    launchId: "launch-1",
    opportunityId: "opportunity-1",
    laneId: "probe-lane",
    validityEnvelopeId: "validity-1",
    targetKey: "target-1",
    authorization,
    evidenceIds: ["profile"],
    createdAt: "2026-08-16T00:00:00Z",
  };

  it("is disabled by default and requires an isolated budget/wallet plus explicit authorization", () => {
    const disabled = new BoundedMicroProbePolicy({
      enabled: false,
      maximumPrincipalUsdMicros: 250_000n,
      strategyId: "probe-v1",
      budgetId: "probe-budget",
      walletId: "probe-wallet",
    });
    assert.throws(() => disabled.createIntent(input), /disabled/);
    assert.throws(
      () =>
        new BoundedMicroProbePolicy({
          enabled: true,
          maximumPrincipalUsdMicros: 250_001n,
          strategyId: "probe-v1",
          budgetId: "probe-budget",
          walletId: "probe-wallet",
        }),
      /0.25U/,
    );
  });

  it("allows at most one bounded intent per launch and never touches the ClockIn strategy", () => {
    const policy = new BoundedMicroProbePolicy({
      enabled: true,
      maximumPrincipalUsdMicros: 250_000n,
      strategyId: "probe-v1",
      budgetId: "probe-budget",
      walletId: "probe-wallet",
    });
    const intent = policy.createIntent(input);
    assert.equal(intent.maxInputRaw, "250000");
    assert.equal(intent.strategyId, "probe-v1");
    assert.equal(intent.action, "PROBE");
    assert.throws(() => policy.createIntent(input), /at most one/);
  });
});
