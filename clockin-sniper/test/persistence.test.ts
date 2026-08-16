import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CanonicalInvariantError,
  stableHash,
  type CapitalReservation,
  type ExecutionPlan,
  type ExitPlan,
  type LaunchIdentity,
  type RouteQuote,
  type StrategyBudget,
  type TxAttempt,
  type WalletLane,
} from "../src/core/canonical.js";
import { planTenFeeBands } from "../src/entry/fee-band-planner.js";
import {
  exportAuditNdjson,
  importLegacyNdjson,
  projectLegacyRecord,
} from "../src/persistence/ndjson-migration.js";
import { SqliteStore } from "../src/persistence/sqlite-store.js";

const ADDRESS = `0x${"1".repeat(40)}` as const;
const TOKEN = `0x${"2".repeat(40)}` as const;
const POOL = `0x${"3".repeat(40)}` as const;
const HASH = `0x${"a".repeat(64)}` as const;
const TX_HASH = `0x${"b".repeat(64)}` as const;
const NOW = "2026-08-16T00:00:00.000Z";

async function tempPath(name: string): Promise<string> {
  const directory = join(
    tmpdir(),
    `clockin-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(directory, { recursive: true });
  return join(directory, name);
}

function budget(strategyId = "clockin-mainnet-v1"): StrategyBudget {
  return Object.freeze({
    budgetId: `${strategyId}:budget`,
    strategyId,
    revision: 1,
    launchId: "launch-1",
    configHash: "sha256:config",
    nominalUnit: "USD_MICROS",
    principalLimit: strategyId === "clockin-mainnet-v1" ? "50000000" : "0",
    evidenceIds: ["policy-v1"],
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function lanes(strategyId = "clockin-mainnet-v1"): readonly WalletLane[] {
  return Object.freeze(
    Array.from(
      { length: 10 },
      (_, index): WalletLane =>
        Object.freeze({
          laneId: `${strategyId}:lane-${index + 1}`,
          strategyId,
          revision: 1,
          walletId: `entry-${String(index + 1).padStart(2, "0")}`,
          address: `0x${String(index + 1).padStart(40, "0")}` as `0x${string}`,
          role: "CLOCKIN_ENTRY",
          trancheNumber: index + 1,
          maxPrincipalRaw: "5000000",
          evidenceIds: ["policy-v1"],
          state: "UNALLOCATED",
          createdAt: NOW,
          updatedAt: NOW,
        }),
    ),
  );
}

function reservation(lane: WalletLane, index: number): CapitalReservation {
  return Object.freeze({
    reservationId: `reservation-${index}`,
    strategyId: lane.strategyId,
    revision: 1,
    budgetId: `${lane.strategyId}:budget`,
    launchId: "launch-1",
    laneId: lane.laneId,
    intentId: `intent-${index}`,
    configHash: "sha256:config",
    principalRaw: "5000000",
    state: "RESERVED",
    evidenceIds: ["authorization-1"],
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function identity(tokenAddress = TOKEN): LaunchIdentity {
  return Object.freeze({
    candidateId: "candidate-1",
    strategyId: "clockin-mainnet-v1",
    revision: 1,
    factoryProfileId: "factory-profile-1",
    creator: ADDRESS,
    tokenAddress,
    poolAddress: POOL,
    name: "ClockIn",
    symbol: "CLOCKIN",
    metadataUri: "ipfs://clockin",
    imageHash: HASH,
    blockNumber: "1",
    blockHash: HASH,
    transactionHash: TX_HASH,
    transactionIndex: "0",
    logIndex: "0",
    evidenceIds: ["evidence-1"],
    observedAt: NOW,
    launchId: "launch-1",
    tokenRuntimeCodeHash: HASH,
    poolRuntimeCodeHash: HASH,
    mechanismProfileId: "mechanism-1",
    identityPolicyHash: "sha256:identity",
    configHash: "sha256:config",
    frozenAt: NOW,
    state: "FROZEN",
  });
}

function executionPlan(revision: number, state: ExecutionPlan["state"]): ExecutionPlan {
  return Object.freeze({
    planId: "plan-1",
    planHash: "sha256:immutable-plan-payload",
    strategyId: "clockin-mainnet-v1",
    revision,
    intentId: "intent-1",
    launchId: "launch-1",
    laneId: "clockin-mainnet-v1:lane-1",
    validityEnvelopeId: "validity-1",
    authorizationId: "authorization-1",
    factoryProfileRevision: 1,
    mechanismProfileRevision: 1,
    adapterId: "configured-launcher-v1",
    walletAddress: lanes()[0]?.address as `0x${string}`,
    nonce: "0",
    to: POOL,
    valueRaw: "5000000",
    calldataHash: HASH,
    methodSelector: "0x12345678",
    observedFeeBps: 4_000,
    targetFeeBps: 4_000,
    quoteBlock: "100",
    minOutputRaw: "1",
    gasLimit: "400000",
    maxFeePerGasRaw: "2000000000",
    maxPriorityFeePerGasRaw: "1000000000",
    capitalReservationId: "reservation-1",
    evidenceIds: Object.freeze(["quote-1"]),
    state,
    createdAt: NOW,
    frozenAt: NOW,
  });
}

function txAttempt(revision: number, state: TxAttempt["state"]): TxAttempt {
  return Object.freeze({
    attemptId: "attempt-1",
    strategyId: "clockin-mainnet-v1",
    revision,
    intentId: "intent-1",
    planId: "plan-1",
    launchId: "launch-1",
    laneId: "clockin-mainnet-v1:lane-1",
    walletAddress: lanes()[0]?.address as `0x${string}`,
    nonce: "0",
    operation: "INITIAL",
    signedTxHash: TX_HASH,
    payloadHash: "keccak256:payload",
    vaultRef: "vault:attempt-1",
    transportEvents: Object.freeze([]),
    state,
    evidenceIds: Object.freeze(["plan-1"]),
    createdAt: NOW,
    updatedAt: `2026-08-16T00:00:0${revision}.000Z`,
  });
}

function routeQuote(revision: number): RouteQuote {
  return Object.freeze({
    quoteId: "route-quote-1",
    strategyId: "clockin-mainnet-v1",
    revision,
    launchId: "launch-1",
    lotId: "lot-1",
    routeId: "launch-pool-v1",
    routeKind: "LAUNCH_POOL",
    tokenInputRaw: "1000",
    grossOutputRaw: revision === 1 ? "2000" : "2200",
    sellTaxRaw: "0",
    priceImpactRaw: "0",
    approvalGasRaw: "100",
    executionGasRaw: "200",
    netOutputRaw: revision === 1 ? "1700" : "1900",
    quoteBlock: String(100 + revision),
    observedAt: `2026-08-16T00:00:0${revision}.000Z`,
    expiresAt: `2026-08-16T00:01:0${revision}.000Z`,
    evidenceIds: Object.freeze([`route-evidence-${revision}`]),
  });
}

function exitPlan(revision: number, state: ExitPlan["state"]): ExitPlan {
  return Object.freeze({
    exitPlanId: "exit-plan-1",
    strategyId: "clockin-mainnet-v1",
    revision,
    launchId: "launch-1",
    positionId: "position-1",
    lotId: "lot-1",
    policyStage: "RECOVER_PRINCIPAL",
    routeQuoteId: "route-quote-1",
    tokenInputRaw: "1000",
    minOutputRaw: "1500",
    validityEnvelopeId: "exit-validity-1",
    state,
    evidenceIds: Object.freeze(["route-quote-1"]),
    createdAt: NOW,
    updatedAt: `2026-08-16T00:00:0${revision}.000Z`,
  });
}

describe("SQLite canonical store", () => {
  it("applies, rolls back and reapplies migrations", () => {
    const store = new SqliteStore(":memory:");
    assert.equal(store.schemaVersion(), 5);
    store.rollbackTo(1);
    assert.equal(store.schemaVersion(), 1);
    store.migrateToLatest();
    assert.equal(store.schemaVersion(), 5);
    store.close();
  });

  it("creates a mode-0600 WAL database and survives restart", async () => {
    const filename = await tempPath("state.sqlite");
    const first = new SqliteStore(filename);
    first.initializeBudget(budget(), lanes());
    first.reserveCapital(reservation(lanes()[0] as WalletLane, 1));
    first.close();

    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    const second = new SqliteStore(filename);
    assert.equal(second.budgetUsage("clockin-mainnet-v1:budget"), 5_000_000n);
    assert.equal(second.tableCount("wallet_lanes"), 10);
    second.close();
  });

  it("persists the exact planner revision across restart", async () => {
    const filename = await tempPath("planner.sqlite");
    const planner = planTenFeeBands(
      4_000,
      0,
      Array.from({ length: 10 }, (_, index) => `wallet-${index + 1}`),
      Array.from({ length: 10 }, (_, index) => `reservation-${index + 1}`),
      5_000_000n,
      {
        strategyId: "clockin-mainnet-v1",
        launchId: "launch-1",
        mechanismProfileRevision: 7,
        createdAt: NOW,
      },
    );
    const first = new SqliteStore(filename);
    assert.equal(first.saveFeeBandPlan(planner), true);
    assert.equal(first.saveFeeBandPlan(planner), false);
    first.close();
    const restarted = new SqliteStore(filename);
    assert.equal(restarted.hasFeeBandPlan(planner.plannerRevision), true);
    assert.equal(restarted.tableCount("fee_band_plans"), 1);
    restarted.close();
  });

  it("reserves exactly ten 5U lanes and never exceeds 50U", () => {
    const store = new SqliteStore(":memory:");
    const laneSet = lanes();
    assert.equal(store.initializeBudget(budget(), laneSet), true);
    assert.equal(store.initializeBudget(budget(), laneSet), false);
    laneSet.forEach((lane, index) => {
      assert.equal(store.reserveCapital(reservation(lane, index + 1)), true);
    });
    assert.equal(store.budgetUsage("clockin-mainnet-v1:budget"), 50_000_000n);

    const extraLane: WalletLane = Object.freeze({
      ...(laneSet[0] as WalletLane),
      laneId: "clockin-mainnet-v1:lane-11",
      walletId: "entry-11",
      address: `0x${"f".repeat(40)}`,
      trancheNumber: 11,
    });
    assert.throws(
      () => store.reserveCapital(reservation(extraLane, 11)),
      (error: unknown) =>
        error instanceof Error &&
        (error.message.includes("does not exist") || error.message.includes("budget")),
    );
    store.close();
  });

  it("keeps the monitor-only first-launch strategy outside the ClockIn budget", () => {
    const store = new SqliteStore(":memory:");
    store.initializeBudget(budget(), lanes());
    const foreign = Object.freeze({
      ...reservation(lanes()[0] as WalletLane, 1),
      reservationId: "first-launch-reservation",
      strategyId: "first-official-launch-v1",
      intentId: "first-launch-intent",
    });
    assert.throws(() => store.reserveCapital(foreign), /does not exist/);
    assert.equal(store.budgetUsage("clockin-mainnet-v1:budget"), 0n);
    store.close();
  });

  it("atomically binds capital and nonce so a nonce conflict rolls back the new reservation", () => {
    const store = new SqliteStore(":memory:");
    const laneSet = lanes();
    store.initializeBudget(budget(), laneSet);
    const address = laneSet[0]?.address;
    if (address === undefined) throw new Error("fixture address missing");
    const epoch = store.acquireServiceLease(
      `wallet:${address.toLowerCase()}`,
      "executor-a",
      "2026-08-16T00:10:00.000Z",
      NOW,
    );
    const slot = {
      walletAddress: address,
      nonce: 0n,
      ownerId: "executor-a",
      fencingEpoch: epoch,
      purpose: "ENTRY" as const,
      state: "RESERVED" as const,
      planId: "plan-1",
    };
    const firstReservation = reservation(laneSet[0] as WalletLane, 1);
    assert.deepEqual(store.reserveCapitalAndNonceSlot(firstReservation, slot, NOW), {
      reservationCreated: true,
      nonceCreated: true,
    });
    const secondReservation = reservation(laneSet[1] as WalletLane, 2);
    assert.throws(
      () =>
        store.reserveCapitalAndNonceSlot(
          secondReservation,
          { ...slot, planId: "plan-conflict" },
          NOW,
        ),
      /already reserved/,
    );
    assert.equal(store.reservationState(secondReservation.reservationId), undefined);
    assert.equal(store.budgetUsage(firstReservation.budgetId), 5_000_000n);
    store.close();
  });

  it("settles only the matching reservation and never reallocates a reverted lane", () => {
    const store = new SqliteStore(":memory:");
    const laneSet = lanes();
    store.initializeBudget(budget(), laneSet);
    const first = reservation(laneSet[0] as WalletLane, 1);
    const second = reservation(laneSet[1] as WalletLane, 2);
    store.reserveCapital(first);
    store.reserveCapital(second);
    assert.equal(
      store.settleReservationFromReceipt(first.reservationId, "REVERTED", NOW),
      "RELEASED",
    );
    assert.equal(store.reservationState(second.reservationId), "RESERVED");
    assert.equal(store.budgetUsage(first.budgetId), 5_000_000n);
    assert.equal(store.settleReservationFromReceipt(second.reservationId, "SUCCESS", NOW), "SPENT");
    assert.equal(store.budgetUsage(first.budgetId), 5_000_000n);
    store.close();
  });

  it("allows only one concurrent reservation for a launch lane", async () => {
    const filename = await tempPath("concurrent.sqlite");
    const first = new SqliteStore(filename);
    first.initializeBudget(budget(), lanes());
    const second = new SqliteStore(filename);
    const target = reservation(lanes()[0] as WalletLane, 1);
    assert.equal(first.reserveCapital(target), true);
    assert.throws(
      () =>
        second.reserveCapital(
          Object.freeze({ ...target, reservationId: "competing", intentId: "competing-intent" }),
        ),
      /UNIQUE constraint failed/,
    );
    first.close();
    second.close();
  });

  it("freezes one launch identity and reports a conflicting CA explicitly", () => {
    const store = new SqliteStore(":memory:");
    assert.equal(store.saveLaunchIdentity(identity()), true);
    assert.equal(store.saveLaunchIdentity(identity()), false);
    assert.throws(
      () => store.saveLaunchIdentity(identity(`0x${"4".repeat(40)}`)),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "IDENTITY_CONFLICT",
    );
    store.close();
  });

  it("increments fencing epochs and rejects a second live lease owner", () => {
    const store = new SqliteStore(":memory:");
    assert.equal(
      store.acquireServiceLease("wallet:entry-01", "executor-a", "2026-08-16T00:01:00.000Z", NOW),
      1,
    );
    assert.throws(
      () =>
        store.acquireServiceLease(
          "wallet:entry-01",
          "executor-b",
          "2026-08-16T00:02:00.000Z",
          "2026-08-16T00:00:30.000Z",
        ),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "NONCE_CONFLICT",
    );
    assert.equal(
      store.acquireServiceLease(
        "wallet:entry-01",
        "executor-b",
        "2026-08-16T00:03:00.000Z",
        "2026-08-16T00:01:01.000Z",
      ),
      2,
    );
    store.close();
  });

  it("persists append-only plan, attempt, quote and exit revisions and returns only the latest", () => {
    const store = new SqliteStore(":memory:");
    store.initializeBudget(budget(), lanes());

    store.saveExecutionPlan(executionPlan(1, "FROZEN"));
    store.saveExecutionPlan(executionPlan(2, "SIGNED"));
    assert.equal(store.tableCount("execution_plans"), 2);
    assert.deepEqual(
      store
        .latestExecutionPlans("clockin-mainnet-v1", "launch-1")
        .map((plan) => [plan.revision, plan.state, plan.planHash]),
      [[2, "SIGNED", "sha256:immutable-plan-payload"]],
    );

    store.saveTxAttempt(txAttempt(1, "SIGNED"));
    store.saveTxAttempt(txAttempt(2, "UNKNOWN"));
    assert.equal(store.tableCount("tx_attempts"), 2);
    assert.equal(store.latestTxAttempts("clockin-mainnet-v1")[0]?.state, "UNKNOWN");
    assert.equal(store.unresolvedTxAttempts("clockin-mainnet-v1").length, 1);
    store.saveTxAttempt(txAttempt(3, "DROPPED_PROVEN"));
    assert.equal(store.tableCount("tx_attempts"), 3);
    assert.equal(store.unresolvedTxAttempts("clockin-mainnet-v1").length, 0);

    store.saveRouteQuote(routeQuote(1));
    store.saveRouteQuote(routeQuote(2));
    assert.equal(store.tableCount("route_quotes"), 2);
    assert.deepEqual(
      store
        .latestRouteQuotes("clockin-mainnet-v1", "launch-1")
        .map((quote) => [quote.revision, quote.netOutputRaw]),
      [[2, "1900"]],
    );

    store.saveExitPlan(exitPlan(1, "ARMED"));
    store.saveExitPlan(exitPlan(2, "DUE"));
    assert.equal(store.tableCount("exit_plans"), 2);
    assert.deepEqual(
      store
        .latestExitPlans("clockin-mainnet-v1", "launch-1")
        .map((plan) => [plan.revision, plan.state]),
      [[2, "DUE"]],
    );
    store.close();
  });

  it("releases only an owned service lease and makes it immediately non-live", () => {
    const store = new SqliteStore(":memory:");
    const epoch = store.acquireServiceLease(
      "wallet:entry-01",
      "executor-a",
      "2026-08-16T00:10:00.000Z",
      NOW,
    );
    assert.equal(store.ownsServiceLease("wallet:entry-01", "executor-a", epoch, NOW), true);
    assert.throws(
      () => store.releaseServiceLease("wallet:entry-01", "executor-b", epoch, NOW),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "NONCE_CONFLICT",
    );
    store.releaseServiceLease("wallet:entry-01", "executor-a", epoch, NOW);
    assert.equal(store.ownsServiceLease("wallet:entry-01", "executor-a", epoch, NOW), false);
    store.close();
  });

  it("imports legacy NDJSON read-only, preserves unknown fields and is idempotent", async () => {
    const filename = await tempPath("legacy.ndjson");
    await writeFile(
      filename,
      [
        JSON.stringify({
          event: "live_session_started",
          at: NOW,
          launchId: "launch-1",
          unknownLegacyField: "preserved",
        }),
        JSON.stringify({
          event: "broadcast_attempted",
          at: "2026-08-16T00:00:01.000Z",
          launchId: "launch-1",
          txHash: TX_HASH,
          nonce: "7",
        }),
      ].join("\n"),
      { mode: 0o600 },
    );
    const store = new SqliteStore(":memory:");
    const first = await importLegacyNdjson(store, filename);
    const second = await importLegacyNdjson(store, filename);
    assert.deepEqual(first, {
      imported: 2,
      duplicates: 0,
      unknownFields: ["unknownLegacyField"],
    });
    assert.deepEqual(second, {
      imported: 0,
      duplicates: 2,
      unknownFields: ["unknownLegacyField"],
    });
    const exported = exportAuditNdjson(store, "clockin-mainnet-v0", "launch-1");
    assert.match(exported, /unknownLegacyField/);
    assert.match(exported, /SESSION_AUDIT/);
    assert.match(exported, /TRANSPORT_ATTEMPT_AUDIT/);
    assert.match(
      exported,
      new RegExp(
        stableHash({
          lineNumber: 1,
          record: JSON.parse((await readFile(filename, "utf8")).split("\n")[0] as string),
        }).slice(0, 12),
      ),
    );
    store.close();
  });

  it("maps plan, receipt, token balance and position records without changing economic fields", () => {
    const plan = projectLegacyRecord({
      event: "plan_frozen",
      txHash: TX_HASH,
      nonce: "7",
    });
    assert.equal(plan.target, "EXECUTION_PLAN_AUDIT");
    assert.deepEqual(plan.txHash, { state: "KNOWN", value: TX_HASH });
    assert.deepEqual(plan.nonce, { state: "KNOWN", value: "7" });
    const receipt = projectLegacyRecord({ event: "receipt_observed", txHash: TX_HASH });
    assert.equal(receipt.target, "RECEIPT_EFFECT_AUDIT");
    const position = projectLegacyRecord({
      event: "position_observed",
      tokenBalanceDeltaRaw: "12345",
    });
    assert.equal(position.target, "POSITION_AUDIT");
    assert.deepEqual(position.tokenDelta, { state: "KNOWN", value: "12345" });
  });
});
