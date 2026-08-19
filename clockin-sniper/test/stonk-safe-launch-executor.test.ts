import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { Interface } from "ethers";

import {
  CLOCKIN_APPROVED_LAUNCH_CREATOR,
  ROBINHOOD_WETH_ADDRESS,
  ROBINHOOD_WETH_RUNTIME_CODE_HASH,
  SAFE_LAUNCH_BUFFER_TAX_BPS,
  STONK_SAFE_LAUNCH_QUOTED_ADAPTER_ID,
  STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
  STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
  STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
  STONK_SAFE_LAUNCH_WETH_FACTORY_RUNTIME_CODE_HASH,
  type StonkSafeLaunchQuotedCreated,
  type StonkSafeLaunchQuotedState,
} from "../src/adapters/stonk-safe-launch-quoted.js";
import {
  CanonicalInvariantError,
  type CapitalReservation,
  type EffectRecord,
  type ExecutionPlan,
  type StrategyBudget,
  type TxAttempt,
  type WalletLane,
} from "../src/core/canonical.js";
import { planTenFeeBands } from "../src/entry/fee-band-planner.js";
import { TenLaneOrchestrator } from "../src/entry/lane-orchestrator.js";
import type { PoolObservation } from "../src/entry/pool-observation.js";
import { createQuoteSnapshot } from "../src/entry/quote-policy.js";
import { SqliteStore } from "../src/persistence/sqlite-store.js";
import type { JsonRpcRequester } from "../src/rpc/types.js";
import {
  createPublicLaunchHandoffRecord,
  type PublicLaunchHandoffRecord,
} from "../src/runtime/public-launch-handoff.js";
import {
  freezeStonkSafeLaunchProductionProfile,
  type StonkSafeLaunchProductionProfile,
} from "../src/runtime/stonk-safe-launch-production-profile.js";
import type { StonkSafeLaunchWalletReadinessRow } from "../src/runtime/stonk-safe-launch-wallet-readiness.js";
import {
  assertPaidExecutorLifecycleActive,
  assertArmedEntryRiskWithinCap,
  assertArmedLaunchBinding,
  assertAuthorizedFeeHeadroom,
  assertCanonicalCreatedMatchesPublicHandoff,
  assertCanonicalSafeLaunchCreated,
  assertDiscoveryMatchesPublicHandoff,
  assertCurrentPublicHandoffStillActive,
  assertFreshCanonicalQuoteAndFee,
  assertQuotedLaneRecoveryReadiness,
  buildQuotedDispatchIds,
  buildCanonicalSafeLaunchIdentity,
  classifyPreBroadcastFailure,
  DeterministicPayloadInvariantFailure,
  dynamicSafeLaunchMechanismId,
  establishPaidExecutorBootstrap,
  evaluateQuotedExpansion,
  freezeQuotedEntryPlan,
  PaidExecutorLifecycleEnded,
  quotedEntryEnabled,
  quotedRemainingLanesReady,
  recoverCanonicalArmedForPublicHandoff,
  recoverQuotedPrePlanOrphans,
  recoverQuotedProvenPreBroadcastOrphans,
  requireQuotedLaneExpectedOutput,
  resolveQuotedLaneExpectedOutputForDispatch,
  runWhilePublicHandoffIsCurrent,
  SAFE_LAUNCH_ARMED_WAIT_TIMEOUT_MS,
  safeLaunchTaxIsBuyable,
  safeLaunchArmedWaitDeadlineMs,
  selectQuotedLaneRecovery,
  wethRawForUsdMicrosAtArmedQuote,
  type QuotedEntryPlanDraft,
} from "../src/stonk-safe-launch-executor-service.js";

const TOKEN = "0x1111111111111111111111111111111111111111" as const;
const TX_HASH = `0x${"22".repeat(32)}` as const;
const BLOCK_HASH = `0x${"33".repeat(32)}` as const;
const NOW = "2026-08-20T00:00:00.000Z";
const createdInterface = new Interface([
  "event LaunchCreated(uint256 indexed id,address indexed token,address indexed creator,bool externalToken)",
]);
const armedInterface = new Interface([
  "event LaunchArmed(uint256 indexed id,uint256 supply,uint256 vQuote0,uint64 quoteUsd8,uint64 deadline)",
]);

function created(
  overrides: Partial<StonkSafeLaunchQuotedCreated> = {},
): StonkSafeLaunchQuotedCreated {
  return Object.freeze({
    kind: "LaunchCreated",
    factoryAddress: STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
    id: 7n,
    tokenAddress: TOKEN,
    creatorAddress: CLOCKIN_APPROVED_LAUNCH_CREATOR,
    externalToken: false,
    blockNumber: 100n,
    transactionHash: TX_HASH,
    logIndex: 3n,
    ...overrides,
  });
}

function createdReceiptLog(event = created()): Readonly<Record<string, unknown>> {
  const encoded = createdInterface.encodeEventLog("LaunchCreated", [
    event.id,
    event.tokenAddress,
    event.creatorAddress,
    event.externalToken,
  ]);
  return Object.freeze({
    address: event.factoryAddress,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: "0x64",
    transactionHash: event.transactionHash,
    logIndex: "0x3",
    removed: false,
  });
}

function armedBackfillLog(
  id = 7n,
  transactionHash = `0x${"44".repeat(32)}`,
): Readonly<Record<string, unknown>> {
  const encoded = armedInterface.encodeEventLog("LaunchArmed", [
    id,
    1_000n,
    2_000n,
    3_000n,
    4_000n,
  ]);
  return Object.freeze({
    address: STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: "0x65",
    transactionHash,
    logIndex: "0x0",
    removed: false,
  });
}

function profile(): StonkSafeLaunchProductionProfile {
  return freezeStonkSafeLaunchProductionProfile({
    formatVersion: 1,
    profileId: "clockin-safe-launch-weth-mainnet-v1",
    revision: 1,
    chainId: 4_663,
    adapterId: STONK_SAFE_LAUNCH_QUOTED_ADAPTER_ID,
    factory: Object.freeze({
      address: STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
      runtimeCodeHash: STONK_SAFE_LAUNCH_WETH_FACTORY_RUNTIME_CODE_HASH,
      startBlock: "40100279",
      launchCreatedTopic: STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
      launchArmedTopic: STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
    }),
    quote: Object.freeze({
      asset: ROBINHOOD_WETH_ADDRESS,
      runtimeCodeHash: ROBINHOOD_WETH_RUNTIME_CODE_HASH,
      fundingMode: "PREWRAPPED_WETH",
      allowanceMode: "PREAPPROVED_EXACT_PAD",
    }),
    identity: Object.freeze({
      expectedCreator: CLOCKIN_APPROVED_LAUNCH_CREATOR,
      expectedName: "Clock In",
      expectedSymbol: "CLOCKIN",
      requirePrimaryExternalToken: false,
      officialCa: Object.freeze({
        url: "https://clockin.win/",
        jsonKey: "contractAddress",
        pollMs: 500,
      }),
    }),
    mechanismBounds: Object.freeze({
      bufferTaxBps: SAFE_LAUNCH_BUFFER_TAX_BPS,
      maximumBufferSeconds: 600,
      maximumStartTaxBps: 9_900,
      minimumDecayPerMinuteBps: 1,
      minimumWindowSeconds: 60,
      maximumWindowSeconds: 5_940,
      minimumDistinctExecutableTaxStates: 10,
      capMode: "NO_CAP",
      cooldownMode: "NONE",
      floorTaxBps: 0,
      eoaOnly: true,
    }),
    entry: Object.freeze({
      refCode: `0x${"00".repeat(32)}`,
      gasLimit: "500000",
      maximumFeePerGasWei: "2000000000",
      maximumPriorityFeePerGasWei: "1000000000",
      quoteMaximumAgeMs: 15_000,
      laterLaneMaximumDriftBps: 300,
      canaryMinimumOutputRaw: "1",
      maximumExecutionDriftBps: 500,
    }),
    expansion: Object.freeze({
      requireCanonicalCanaryEffect: true,
      requireStrongOnchainBinding: true,
      requireExecutableExitBeforeLanes2To10: false,
    }),
    evidenceIds: Object.freeze(["verified-pad", "approved-creator"]),
    createdAt: NOW,
  });
}

function launch(overrides: Partial<StonkSafeLaunchQuotedState> = {}): StonkSafeLaunchQuotedState {
  return Object.freeze({
    id: 7n,
    tokenAddress: TOKEN,
    creatorAddress: CLOCKIN_APPROVED_LAUNCH_CREATOR,
    startMcapUsd8: 1n,
    graduationMcapUsd8: 2n,
    startTaxBps: 3_300,
    decayPerMinuteBps: 100,
    creatorFeeBps: 100,
    protocolFeeBps: 100,
    windowSeconds: 1_980,
    bufferSeconds: 300,
    startTime: 1_000n,
    deadline: 3_280n,
    externalToken: false,
    sellsEnabled: true,
    armed: true,
    graduated: false,
    bonded: false,
    aborted: false,
    loadedSupply: 1_000n,
    virtualQuote: 2_000n,
    virtualToken: 3_000n,
    realQuote: 0n,
    buyCount: 0n,
    ...overrides,
  });
}

function draft(): QuotedEntryPlanDraft {
  return {
    planId: "plan-1",
    strategyId: "clockin-mainnet-v1",
    revision: 1,
    intentId: "intent-1",
    launchId: "launch-1",
    laneId: "clockin-entry-01",
    validityEnvelopeId: "validity-1",
    authorizationId: "authorization-1",
    factoryProfileRevision: 1,
    mechanismProfileRevision: 1,
    adapterId: STONK_SAFE_LAUNCH_QUOTED_ADAPTER_ID,
    walletAddress: "0x4444444444444444444444444444444444444444",
    nonce: "0",
    to: STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
    valueRaw: "0",
    calldataHash: `0x${"55".repeat(32)}`,
    methodSelector: "0x12345678",
    observedFeeBps: 4_000,
    targetFeeBps: 4_000,
    gasLimit: "500000",
    maxFeePerGasRaw: "2000000000",
    maxPriorityFeePerGasRaw: "1000000000",
    capitalReservationId: "reservation-1",
    evidenceIds: Object.freeze(["quote-1"]),
    createdAt: NOW,
  };
}

function confirmedAttempt(plan: ExecutionPlan): TxAttempt {
  return Object.freeze({
    attemptId: "attempt-1",
    strategyId: plan.strategyId,
    revision: 2,
    intentId: plan.intentId,
    planId: plan.planId,
    launchId: plan.launchId,
    laneId: plan.laneId,
    walletAddress: plan.walletAddress,
    nonce: plan.nonce,
    operation: "INITIAL",
    signedTxHash: TX_HASH,
    payloadHash: `keccak256:${TX_HASH.slice(2)}`,
    transportEvents: Object.freeze([]),
    state: "CONFIRMED_SUCCESS",
    evidenceIds: Object.freeze([plan.planHash]),
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function canonicalEffect(attempt: TxAttempt): EffectRecord {
  const known = <T>(value: T) =>
    Object.freeze({
      state: "KNOWN" as const,
      value,
      observedAt: NOW,
      evidenceIds: Object.freeze([]),
    });
  return Object.freeze({
    effectId: "effect-1",
    strategyId: attempt.strategyId,
    revision: 1,
    intentId: attempt.intentId,
    attemptId: attempt.attemptId,
    launchId: attempt.launchId,
    laneId: attempt.laneId,
    side: "ENTRY",
    result: "SUCCESS",
    canonicality: "CANONICAL",
    txHash: attempt.signedTxHash,
    blockNumber: known("101"),
    blockHash: known(BLOCK_HASH),
    transactionIndex: known("1"),
    assetDeltas: known(Object.freeze([])),
    principalDeltaRaw: known("-5000"),
    tokenDeltaRaw: known("700"),
    gasCostRaw: known("1"),
    declaredFeeBps: known(100),
    actualOutputRaw: known("700"),
    settlement: "RESIDUAL_POSITION",
    positionLotIds: Object.freeze(["lot-1"]),
    evidenceIds: Object.freeze([attempt.attemptId]),
    observedAt: NOW,
  });
}

function readinessRow(
  overrides: Partial<StonkSafeLaunchWalletReadinessRow> = {},
): StonkSafeLaunchWalletReadinessRow {
  return Object.freeze({
    walletId: "entry-01",
    address: draft().walletAddress,
    latestNonce: 1n,
    pendingNonce: 1n,
    nativeBalanceWei: 0n,
    wethBalanceRaw: 0n,
    wethAllowanceRaw: 0n,
    requiredWethRaw: 5_000n,
    requiredNativeGasWei: 10n,
    eoaReady: true,
    nonceReady: true,
    gasReady: false,
    wethReady: false,
    allowanceReady: false,
    ready: false,
    ...overrides,
  });
}

function durablePreBroadcastFixture(suffix: string): Readonly<{
  store: SqliteStore;
  plan: ExecutionPlan;
  reservation: CapitalReservation;
  lane: WalletLane;
}> {
  const store = new SqliteStore(":memory:");
  const planDraft = Object.freeze({
    ...draft(),
    planId: `entry-plan:${suffix}`,
    capitalReservationId: `entry-reservation:${suffix}`,
  });
  const lane = Object.freeze({
    laneId: planDraft.laneId,
    strategyId: planDraft.strategyId,
    revision: 1,
    walletId: "entry-01",
    address: planDraft.walletAddress,
    role: "CLOCKIN_ENTRY" as const,
    trancheNumber: 1,
    maxPrincipalRaw: "5000000",
    evidenceIds: Object.freeze(["policy-v1"]),
    state: "UNALLOCATED" as const,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const budget = Object.freeze({
    budgetId: `budget-${suffix}`,
    strategyId: planDraft.strategyId,
    revision: 1,
    launchId: planDraft.launchId,
    configHash: "sha256:config",
    nominalUnit: "USD_MICROS" as const,
    principalLimit: "50000000",
    evidenceIds: Object.freeze(["policy-v1"]),
    createdAt: NOW,
    updatedAt: NOW,
  });
  const reservation = Object.freeze({
    reservationId: planDraft.capitalReservationId,
    strategyId: planDraft.strategyId,
    revision: 1,
    budgetId: budget.budgetId,
    launchId: planDraft.launchId,
    laneId: planDraft.laneId,
    intentId: planDraft.intentId,
    configHash: "sha256:config",
    principalRaw: "5000000",
    state: "RESERVED" as const,
    evidenceIds: Object.freeze(["authorization-1"]),
    createdAt: NOW,
    updatedAt: NOW,
  });
  store.initializeBudget(budget, [lane]);
  const epoch = store.acquireServiceLease(
    `wallet:${lane.address.toLowerCase()}`,
    "executor-a",
    "2026-08-20T00:10:00.000Z",
    NOW,
  );
  store.claimWalletEntryIntent({
    strategyId: reservation.strategyId,
    launchId: reservation.launchId,
    walletAddress: lane.address,
    intentId: reservation.intentId,
    createdAt: NOW,
  });
  store.reserveCapitalAndNonceSlot(
    reservation,
    {
      walletAddress: lane.address,
      nonce: 0n,
      ownerId: "executor-a",
      fencingEpoch: epoch,
      purpose: "ENTRY",
      state: "RESERVED",
      planId: planDraft.planId,
    },
    NOW,
  );
  const quote = createQuoteSnapshot({
    laneId: lane.laneId,
    poolObservationId: `observation-${suffix}`,
    profileRevision: 1,
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    principalRaw: 5_000n,
    expectedTokenOutRaw: 10_000n,
    observedAtMs: 1,
    expiresAtMs: 10,
    evidenceIds: Object.freeze([`observation-${suffix}`]),
  });
  const plan = freezeQuotedEntryPlan({ draft: planDraft, quote, minOutputRaw: 1n });
  store.saveExecutionPlan(plan);
  return Object.freeze({ store, plan, reservation, lane });
}

describe("quoted Safe Launch executor primitives", () => {
  it("derives exact at-most-5U WETH from LaunchArmed and enforces the 60U all-in bound", () => {
    const quoteUsd8 = 211_442_500_000n;
    const raw = wethRawForUsdMicrosAtArmedQuote(5_000_000n, quoteUsd8);
    assert.equal(raw, (5_000_000n * 100_000_000_000_000_000_000n) / quoteUsd8);
    assert.ok(raw * quoteUsd8 <= 5_000_000n * 100_000_000_000_000_000_000n);
    const risk = assertArmedEntryRiskWithinCap({
      quoteUsd8,
      laneCount: 10,
      nominalLaneUsdMicros: 5_000_000n,
      gasLimit: 500_000n,
      maximumFeePerGasWei: 200_000_000n,
      allInRiskCapUsdMicros: 60_000_000n,
    });
    assert.equal(risk.principalUsdMicros, 50_000_000n);
    assert.ok(risk.totalUsdMicros <= 60_000_000n);
    assert.throws(
      () =>
        assertArmedEntryRiskWithinCap({
          quoteUsd8,
          laneCount: 10,
          nominalLaneUsdMicros: 5_000_000n,
          gasLimit: 500_000n,
          maximumFeePerGasWei: 20_000_000_000n,
          allInRiskCapUsdMicros: 60_000_000n,
        }),
      /exceeds/u,
    );
  });

  it("revalidates quote canonicality/expiry and authorized EIP-1559 headroom", async () => {
    const quote = createQuoteSnapshot({
      laneId: "clockin-entry-01",
      poolObservationId: "observation-fee",
      profileRevision: 1,
      blockNumber: 100n,
      blockHash: BLOCK_HASH,
      principalRaw: 5_000n,
      expectedTokenOutRaw: 10_000n,
      observedAtMs: 1_000,
      expiresAtMs: 2_000,
      evidenceIds: Object.freeze(["observation-fee"]),
    });
    const requester: JsonRpcRequester = {
      providerId: "quote-fee-fixture",
      async request<T>(_method: string, params: readonly unknown[] = []): Promise<T> {
        return (
          params[0] === "latest"
            ? { number: "0x65", hash: `0x${"44".repeat(32)}`, baseFeePerGas: "0x3b9aca00" }
            : { number: "0x64", hash: BLOCK_HASH, baseFeePerGas: "0x3b9aca00" }
        ) as T;
      },
    };
    await assert.doesNotReject(
      assertFreshCanonicalQuoteAndFee({
        requester,
        quote,
        expectedBlockHash: BLOCK_HASH,
        nowMs: 1_500,
        maximumDriftBps: 300,
        maximumFeePerGasWei: 2_000_000_000n,
        maximumPriorityFeePerGasWei: 1_000_000_000n,
      }),
    );
    assert.throws(
      () =>
        assertAuthorizedFeeHeadroom({
          baseFeePerGasWei: 1_000_000_001n,
          maximumPriorityFeePerGasWei: 1_000_000_000n,
          maximumFeePerGasWei: 2_000_000_000n,
        }),
      /authorized maximum fee/u,
    );
    await assert.rejects(
      assertFreshCanonicalQuoteAndFee({
        requester,
        quote,
        expectedBlockHash: BLOCK_HASH,
        nowMs: 2_001,
        maximumDriftBps: 300,
        maximumFeePerGasWei: 2_000_000_000n,
        maximumPriorityFeePerGasWei: 1_000_000_000n,
      }),
      /stale|expired/u,
    );
  });

  it("turns public handoff tombstone/replacement into a restart-required failure", async () => {
    const expected = createPublicLaunchHandoffRecord(created(), BLOCK_HASH, NOW);
    await assert.doesNotReject(
      assertCurrentPublicHandoffStillActive({
        expected,
        readCurrent: async () => expected,
      }),
    );
    await assert.rejects(
      assertCurrentPublicHandoffStillActive({
        expected,
        readCurrent: async () => null,
      }),
      /invalidated or replaced/u,
    );
    const replacement = createPublicLaunchHandoffRecord(
      created({ id: 8n, transactionHash: `0x${"77".repeat(32)}`, logIndex: 4n }),
      `0x${"88".repeat(32)}`,
      NOW,
    );
    await assert.rejects(
      assertCurrentPublicHandoffStillActive({
        expected,
        readCurrent: async () => replacement,
      }),
      /invalidated or replaced/u,
    );
  });

  it("interrupts an Armed wait on A tombstone/replacement so a restart reads B", async () => {
    const handoffA = createPublicLaunchHandoffRecord(created(), BLOCK_HASH, NOW);
    const handoffB = createPublicLaunchHandoffRecord(
      created({ id: 8n, transactionHash: `0x${"77".repeat(32)}`, logIndex: 4n }),
      `0x${"88".repeat(32)}`,
      NOW,
    );
    let current: PublicLaunchHandoffRecord | null = handoffA;
    let operationAborted = false;
    let signalOperationStarted: (() => void) | undefined;
    const operationStarted = new Promise<void>((resolve) => {
      signalOperationStarted = resolve;
    });
    const oldExecutor = runWhilePublicHandoffIsCurrent({
      expected: handoffA,
      readCurrent: async () => current,
      pollIntervalMs: 10,
      operation: async (signal) => {
        signalOperationStarted?.();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              operationAborted = true;
              reject(signal.reason ?? new Error("discovery aborted"));
            },
            { once: true },
          );
        });
      },
    });
    await operationStarted;

    // A direct A -> B replacement must beat the blocked LaunchArmed discovery promise even when
    // systemd's active.signal PathChanged event was a no-op for the already-running A process.
    current = handoffB;
    await assert.rejects(oldExecutor, /invalidated or replaced/u);
    assert.equal(operationAborted, true);

    const restarted = await establishPaidExecutorBootstrap({
      readCurrentHandoff: async () => current,
      assertApprovals: async () => undefined,
      loadPaidRuntime: async () => "paid-runtime",
    });
    assert.equal(restarted.handoff.handoffId, handoffB.handoffId);
  });

  it("freezes an ERC20 execution plan with zero native value and exact-block quote", () => {
    const quote = createQuoteSnapshot({
      laneId: "clockin-entry-01",
      poolObservationId: "observation-1",
      profileRevision: 1,
      blockNumber: 100n,
      blockHash: BLOCK_HASH,
      principalRaw: 5_000n,
      expectedTokenOutRaw: 10_000n,
      observedAtMs: 1,
      expiresAtMs: 10,
      evidenceIds: Object.freeze(["observation-1"]),
    });
    const plan = freezeQuotedEntryPlan({ draft: draft(), quote, minOutputRaw: 9_000n });
    assert.equal(plan.valueRaw, "0");
    assert.equal(plan.quoteBlock, "100");
    assert.equal(plan.minOutputRaw, "9000");
    assert.equal(plan.state, "FROZEN");
    assert.throws(
      () =>
        freezeQuotedEntryPlan({
          draft: { ...draft(), valueRaw: "1" } as unknown as QuotedEntryPlanDraft,
          quote,
          minOutputRaw: 9_000n,
        }),
      /value must be zero/,
    );
  });

  it("never buys the 9999-bps buffer and unlocks later lanes without an exit dependency", () => {
    assert.equal(safeLaunchTaxIsBuyable(9_999, 9_900, 100), false);
    assert.equal(safeLaunchTaxIsBuyable(4_000, 4_000, 100), true);
    assert.equal(safeLaunchTaxIsBuyable(4_001, 4_000, 100), false);
    assert.equal(safeLaunchTaxIsBuyable(100, 4_000, 100), true);
    assert.equal(safeLaunchTaxIsBuyable(0, 4_000, 100), false);
    assert.equal(safeLaunchTaxIsBuyable(0, 4_000, 0), true);
    const reachablePlan = planTenFeeBands(
      3_300,
      100,
      Array.from({ length: 10 }, (_, index) => `entry-${String(index + 1).padStart(2, "0")}`),
      Array.from({ length: 10 }, (_, index) => `reservation-${index + 1}`),
    );
    assert.equal(reachablePlan.lanes.at(-1)?.targetFeeBps, 100);
    assert.equal(
      reachablePlan.lanes.some((lane) => lane.targetFeeBps === 0),
      false,
    );
    assert.deepEqual(
      evaluateQuotedExpansion({
        canonicalCanaryEffect: true,
        strongCreatorPadBinding: true,
        allWalletsReady: true,
        reconcilerReady: true,
      }),
      { ready: true, reasons: [] },
    );
    assert.match(
      evaluateQuotedExpansion({
        canonicalCanaryEffect: false,
        strongCreatorPadBinding: true,
        allWalletsReady: true,
        reconcilerReady: true,
      }).reasons.join(" "),
      /canary effect/,
    );
  });

  it("binds exact Armed state and derives the mechanism id from chain economics", () => {
    const configured = profile();
    const state = launch();
    assert.doesNotThrow(() =>
      assertArmedLaunchBinding({
        profile: configured,
        launch: state,
        launchId: 7n,
        tokenAddress: TOKEN,
        armedDeadline: 3_280n,
      }),
    );
    assert.equal(
      dynamicSafeLaunchMechanismId(configured, state),
      "safe-launch-quoted:1:3300-100-1980-300",
    );
    assert.throws(
      () =>
        assertArmedLaunchBinding({
          profile: configured,
          launch: launch({ creatorAddress: ROBINHOOD_WETH_ADDRESS }),
          launchId: 7n,
          tokenAddress: TOKEN,
          armedDeadline: 3_280n,
        }),
      /binding is invalid/,
    );
  });

  it("persists a canonical identity from exact token code, receipt and created block", async () => {
    const requester: JsonRpcRequester = {
      providerId: "identity-fixture",
      async request<T>(method: string): Promise<T> {
        if (method === "eth_getCode") return "0x60006000" as T;
        if (method === "eth_getTransactionReceipt") {
          return {
            blockNumber: "0x64",
            blockHash: BLOCK_HASH,
            transactionHash: TX_HASH,
            transactionIndex: "0x2",
            status: "0x1",
            logs: [createdReceiptLog()],
          } as T;
        }
        if (method === "eth_getBlockByNumber") {
          return { number: "0x64", hash: BLOCK_HASH } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const identity = await buildCanonicalSafeLaunchIdentity({
      requester,
      profile: profile(),
      created: created(),
      metadata: { name: "Clock In", symbol: "CLOCKIN" },
      launch: launch(),
      frozenAt: NOW,
    });
    assert.equal(identity.poolAddress, STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS);
    assert.equal(identity.tokenAddress, TOKEN);
    assert.equal(identity.transactionIndex, "2");
    assert.equal(identity.mechanismProfileId, "safe-launch-quoted:1:3300-100-1980-300");
    assert.match(identity.tokenRuntimeCodeHash, /^0x[0-9a-f]{64}$/u);
    assert.equal(identity.state, "FROZEN");

    await assert.rejects(
      buildCanonicalSafeLaunchIdentity({
        requester,
        profile: profile(),
        created: created({ creatorAddress: ROBINHOOD_WETH_ADDRESS }),
        metadata: { name: "Clock In", symbol: "CLOCKIN" },
        launch: launch(),
        frozenAt: NOW,
      }),
      /creator is not/,
    );
  });

  it("strictly reads the public handoff before marker checks or paid credential loads", async () => {
    const order: string[] = [];
    const handoff = createPublicLaunchHandoffRecord(created(), BLOCK_HASH, NOW);
    const bootstrap = await establishPaidExecutorBootstrap({
      readCurrentHandoff: async () => {
        order.push("handoff");
        return handoff;
      },
      assertApprovals: async () => {
        order.push("markers");
      },
      loadPaidRuntime: async () => {
        order.push("paid-credentials");
        return Object.freeze({ rpc: "loaded" });
      },
    });
    assert.deepEqual(order, ["handoff", "markers", "paid-credentials"]);
    assert.equal(bootstrap.handoff.handoffId, handoff.handoffId);
    assert.equal(bootstrap.paidRuntime.rpc, "loaded");

    order.length = 0;
    await assert.rejects(
      establishPaidExecutorBootstrap({
        readCurrentHandoff: async () => {
          order.push("handoff");
          return null;
        },
        assertApprovals: async () => {
          order.push("markers");
        },
        loadPaidRuntime: async () => {
          order.push("paid-credentials");
          return "never";
        },
      }),
      /handoff is missing/,
    );
    assert.deepEqual(order, ["handoff"]);
  });

  it("binds paid discovery to every public handoff coordinate", () => {
    const handoff = createPublicLaunchHandoffRecord(created(), BLOCK_HASH, NOW);
    assert.doesNotThrow(() => assertDiscoveryMatchesPublicHandoff(handoff, created()));
    assert.doesNotThrow(() =>
      assertCanonicalCreatedMatchesPublicHandoff(handoff, { blockHash: BLOCK_HASH }),
    );
    assert.throws(
      () =>
        assertCanonicalCreatedMatchesPublicHandoff(handoff, {
          blockHash: `0x${"44".repeat(32)}`,
        }),
      /block hash differs/,
    );
    assert.throws(
      () => assertDiscoveryMatchesPublicHandoff(handoff, created({ logIndex: 4n })),
      /does not match/,
    );
    assert.throws(
      () =>
        assertDiscoveryMatchesPublicHandoff(
          handoff,
          created({ tokenAddress: ROBINHOOD_WETH_ADDRESS }),
        ),
      /does not match/,
    );
  });

  it("canonically backfills an already-Armed handoff before applying the restart wait timeout", async () => {
    const handoff = createPublicLaunchHandoffRecord(created(), BLOCK_HASH, NOW);
    const requests: Readonly<{ method: string; params: readonly unknown[] }>[] = [];
    const requester: JsonRpcRequester = {
      providerId: "armed-restart-backfill",
      async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
        requests.push({ method, params });
        if (method === "eth_blockNumber") return "0x66" as T;
        if (method === "eth_getLogs") return [armedBackfillLog()] as T;
        throw new Error(`unexpected ${method}`);
      },
    };
    const recovered = await recoverCanonicalArmedForPublicHandoff({ requester, handoff });
    assert.equal(recovered?.id, 7n);
    assert.equal(recovered?.blockNumber, 101n);
    assert.equal(recovered?.deadline, 4_000n);
    assert.deepEqual(requests, [
      { method: "eth_blockNumber", params: [] },
      {
        method: "eth_getLogs",
        params: [
          {
            address: STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
            topics: [STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC],
            fromBlock: "0x64",
            toBlock: "0x66",
          },
        ],
      },
    ]);

    const missingRequester: JsonRpcRequester = {
      ...requester,
      async request<T>(method: string): Promise<T> {
        if (method === "eth_blockNumber") return "0x66" as T;
        if (method === "eth_getLogs") return [armedBackfillLog(8n)] as T;
        throw new Error(`unexpected ${method}`);
      },
    };
    assert.equal(
      await recoverCanonicalArmedForPublicHandoff({ requester: missingRequester, handoff }),
      null,
    );
  });

  it("rechecks the canonical receipt block and exact Created event", async () => {
    const event = created();
    const requester: JsonRpcRequester = {
      providerId: "canonical-created-fixture",
      async request<T>(method: string): Promise<T> {
        if (method === "eth_getTransactionReceipt") {
          return {
            blockNumber: "0x64",
            blockHash: BLOCK_HASH,
            transactionHash: TX_HASH,
            transactionIndex: "0x2",
            status: "0x1",
            logs: [createdReceiptLog(event)],
          } as T;
        }
        if (method === "eth_getBlockByNumber") {
          return { number: "0x64", hash: BLOCK_HASH } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const canonical = await assertCanonicalSafeLaunchCreated({ requester, created: event });
    assert.equal(canonical.blockHash, BLOCK_HASH);
    assert.equal(canonical.transactionIndex, 2n);

    const changedEventRequester: JsonRpcRequester = {
      ...requester,
      async request<T>(method: string): Promise<T> {
        if (method === "eth_getTransactionReceipt") {
          return {
            blockNumber: "0x64",
            blockHash: BLOCK_HASH,
            transactionHash: TX_HASH,
            transactionIndex: "0x2",
            status: "0x1",
            logs: [createdReceiptLog(created({ tokenAddress: ROBINHOOD_WETH_ADDRESS }))],
          } as T;
        }
        return requester.request<T>(method, []);
      },
    };
    await assert.rejects(
      assertCanonicalSafeLaunchCreated({ requester: changedEventRequester, created: event }),
      /differs from the bound candidate/,
    );
  });

  it("returns an immutable canonical ExecutionPlan shape", () => {
    const quote = createQuoteSnapshot({
      laneId: "clockin-entry-01",
      poolObservationId: "observation-1",
      profileRevision: 1,
      blockNumber: 100n,
      blockHash: BLOCK_HASH,
      principalRaw: 5_000n,
      expectedTokenOutRaw: 10_000n,
      observedAtMs: 1,
      expiresAtMs: 10,
      evidenceIds: Object.freeze(["observation-1"]),
    });
    const plan: ExecutionPlan = freezeQuotedEntryPlan({
      draft: draft(),
      quote,
      minOutputRaw: 1n,
    });
    assert.equal(Object.isFrozen(plan), true);
  });

  it("classifies safe pre-broadcast failures as retryable and only explicit invariants as final", () => {
    assert.equal(classifyPreBroadcastFailure(new Error("database is busy")), "DEFERRED_RETRY");
    assert.equal(classifyPreBroadcastFailure(new Error("balance RPC timed out")), "DEFERRED_RETRY");
    assert.equal(
      classifyPreBroadcastFailure(new CanonicalInvariantError("NONCE_CONFLICT", "stale read")),
      "DEFERRED_RETRY",
    );
    assert.equal(
      classifyPreBroadcastFailure(
        new CanonicalInvariantError("BUDGET_EXCEEDED", "deterministic budget conflict"),
      ),
      "FAILED_FINAL",
    );
    assert.equal(
      classifyPreBroadcastFailure(
        new CanonicalInvariantError("IDENTITY_CONFLICT", "deterministic identity conflict"),
      ),
      "FAILED_FINAL",
    );
    assert.equal(
      classifyPreBroadcastFailure(
        new DeterministicPayloadInvariantFailure("deterministic calldata conflict"),
      ),
      "FAILED_FINAL",
    );
  });

  it("keeps one business intent while every block observation gets a fresh plan and reservation", () => {
    const common = {
      launchId: "launch-1",
      laneId: "clockin-entry-01",
      walletAddress: "0x4444444444444444444444444444444444444444" as const,
      nonce: 7n,
    };
    const first = buildQuotedDispatchIds({
      ...common,
      observationId: "observation-100",
      blockNumber: 100n,
      blockHash: BLOCK_HASH,
    });
    const second = buildQuotedDispatchIds({
      ...common,
      observationId: "observation-101",
      blockNumber: 101n,
      blockHash: `0x${"44".repeat(32)}`,
    });
    assert.equal(first.intentId, second.intentId);
    assert.notEqual(first.planId, second.planId);
    assert.notEqual(first.reservationId, second.reservationId);
    assert.match(first.planId, /^entry-plan:sha256:/u);
    assert.match(first.reservationId, /^entry-reservation:sha256:/u);
  });

  it("atomically releases a provably unsigned pre-plan orphan before readiness", () => {
    const store = new SqliteStore(":memory:");
    const planDraft = Object.freeze({
      ...draft(),
      planId: "entry-plan:direct-orphan-fixture",
      capitalReservationId: "entry-reservation:direct-orphan-fixture",
    });
    const lane = Object.freeze({
      laneId: planDraft.laneId,
      strategyId: planDraft.strategyId,
      revision: 1,
      walletId: "entry-01",
      address: planDraft.walletAddress,
      role: "CLOCKIN_ENTRY",
      trancheNumber: 1,
      maxPrincipalRaw: "5000000",
      evidenceIds: Object.freeze(["policy-v1"]),
      state: "UNALLOCATED",
      createdAt: NOW,
      updatedAt: NOW,
    }) satisfies WalletLane;
    const budget = Object.freeze({
      budgetId: "budget-1",
      strategyId: planDraft.strategyId,
      revision: 1,
      launchId: planDraft.launchId,
      configHash: "sha256:config",
      nominalUnit: "USD_MICROS",
      principalLimit: "50000000",
      evidenceIds: Object.freeze(["policy-v1"]),
      createdAt: NOW,
      updatedAt: NOW,
    }) satisfies StrategyBudget;
    const reservation = Object.freeze({
      reservationId: planDraft.capitalReservationId,
      strategyId: planDraft.strategyId,
      revision: 1,
      budgetId: budget.budgetId,
      launchId: planDraft.launchId,
      laneId: planDraft.laneId,
      intentId: planDraft.intentId,
      configHash: "sha256:config",
      principalRaw: "5000000",
      state: "RESERVED",
      evidenceIds: Object.freeze(["authorization-1"]),
      createdAt: NOW,
      updatedAt: NOW,
    }) satisfies CapitalReservation;
    store.initializeBudget(budget, [lane]);
    const epoch = store.acquireServiceLease(
      `wallet:${lane.address.toLowerCase()}`,
      "executor-a",
      "2026-08-20T00:10:00.000Z",
      NOW,
    );
    store.claimWalletEntryIntent({
      strategyId: reservation.strategyId,
      launchId: reservation.launchId,
      walletAddress: lane.address,
      intentId: reservation.intentId,
      createdAt: NOW,
    });
    store.reserveCapitalAndNonceSlot(
      reservation,
      {
        walletAddress: lane.address,
        nonce: 0n,
        ownerId: "executor-a",
        fencingEpoch: epoch,
        purpose: "ENTRY",
        state: "RESERVED",
        planId: planDraft.planId,
      },
      NOW,
    );
    assert.equal(store.walletHasUnresolvedNonce(lane.address), true);

    const released = recoverQuotedPrePlanOrphans({
      store,
      launchId: reservation.launchId,
      ownerId: "executor-a",
      recoveredAt: "2026-08-20T00:00:01.000Z",
    });
    assert.equal(released.length, 1);
    assert.equal(released[0]?.reservationId, reservation.reservationId);
    assert.equal(store.reservationState(reservation.reservationId), "RELEASED");
    assert.equal(store.walletHasUnresolvedNonce(lane.address), false);
    assert.equal(store.budgetUsage(budget.budgetId), 0n);
    store.close();
  });

  it("invalidates a FROZEN plan that crashed before the durable pre-broadcast snapshot", () => {
    const fixture = durablePreBroadcastFixture("frozen-boundary");
    assert.deepEqual(
      recoverQuotedPrePlanOrphans({
        store: fixture.store,
        launchId: fixture.reservation.launchId,
        ownerId: "executor-a",
        recoveredAt: "2026-08-20T00:00:01.000Z",
      }),
      [],
    );
    const released = recoverQuotedProvenPreBroadcastOrphans({
      store: fixture.store,
      launchId: fixture.reservation.launchId,
      ownerId: "executor-a",
      recoveredAt: "2026-08-20T00:00:01.000Z",
    });
    assert.equal(released.length, 1);
    assert.equal(released[0]?.previousPlanState, "FROZEN");
    assert.equal(
      fixture.store.latestExecutionPlans(fixture.plan.strategyId, fixture.plan.launchId)[0]?.state,
      "INVALIDATED",
    );
    assert.equal(fixture.store.walletHasUnresolvedNonce(fixture.lane.address), false);
    fixture.store.close();
  });

  it("repairs SIGNED+attempt before snapshot but never releases once the snapshot exists", () => {
    for (const withSnapshot of [false, true]) {
      const fixture = durablePreBroadcastFixture(`attempt-boundary-${withSnapshot}`);
      const signedPlan = Object.freeze({ ...fixture.plan, revision: 2, state: "SIGNED" as const });
      fixture.store.saveExecutionPlan(signedPlan);
      const slot = fixture.store.walletNonceSlot(fixture.lane.address, 0n);
      if (slot === undefined) throw new Error("nonce fixture is missing");
      fixture.store.updateWalletNonceSlot(slot, "SIGNED", NOW);
      const attempt = Object.freeze({
        ...confirmedAttempt(signedPlan),
        revision: 1,
        state: "SIGNED" as const,
        vaultRef: `/vault/${withSnapshot ? "protected" : "releasable"}`,
      });
      fixture.store.saveTxAttempt(attempt);
      if (withSnapshot) {
        fixture.store.appendAuditEvent({
          eventId: `snapshot-${attempt.attemptId}`,
          eventKind: "ENTRY_PRE_BROADCAST_SNAPSHOT",
          strategyId: attempt.strategyId,
          launchId: attempt.launchId,
          objectId: attempt.attemptId,
          payload: { formatVersion: 1 },
          observedAt: NOW,
        });
      }
      const released = recoverQuotedProvenPreBroadcastOrphans({
        store: fixture.store,
        launchId: fixture.reservation.launchId,
        ownerId: "executor-a",
        recoveredAt: "2026-08-20T00:00:01.000Z",
      });
      assert.equal(released.length, withSnapshot ? 0 : 1);
      assert.equal(fixture.store.walletHasUnresolvedNonce(fixture.lane.address), withSnapshot);
      assert.equal(
        fixture.store.latestTxAttempts(attempt.strategyId, attempt.launchId)[0]?.state,
        withSnapshot ? "SIGNED" : "DROPPED_PROVEN",
      );
      fixture.store.close();
    }
  });

  it("keeps the canary retryable when its exact quoted output is transiently unavailable", async () => {
    assert.throws(
      () => requireQuotedLaneExpectedOutput(new Map(), "clockin-entry-01"),
      /no current quoted output/u,
    );
    const quote = createQuoteSnapshot({
      laneId: "clockin-entry-01",
      poolObservationId: "observation-canary-quote",
      profileRevision: 1,
      blockNumber: 100n,
      blockHash: BLOCK_HASH,
      principalRaw: 5_000n,
      expectedTokenOutRaw: 777n,
      observedAtMs: 1_000,
      expiresAtMs: 2_000,
      evidenceIds: Object.freeze(["quote-evidence"]),
    });
    assert.equal(
      requireQuotedLaneExpectedOutput(new Map([[quote.laneId, quote]]), quote.laneId),
      777n,
    );
    const feePlan = planTenFeeBands(
      4_000,
      100,
      Array.from({ length: 10 }, (_, index) => `entry-${String(index + 1).padStart(2, "0")}`),
      Array.from({ length: 10 }, (_, index) => `reservation-${index + 1}`),
    );
    const orchestrator = new TenLaneOrchestrator(feePlan, {
      batchPrincipalRaw: 5_000n,
      minimumShrunkPrincipalRaw: 5_000n,
      aggregatePrincipalCapRaw: 50_000n,
      catchUpPolicy: "ONE_PER_BLOCK",
      maxConcurrentCatchUpLanes: 1,
      capPolicy: "STRICT_5U",
    });
    const observation = (blockNumber: bigint, blockHash: `0x${string}`): PoolObservation => ({
      observationId: `observation-${blockNumber.toString()}`,
      profileRevision: 1,
      block: { blockNumber, blockHash, blockTimestamp: 1_000n + blockNumber },
      currentFeeBps: 4_000,
      inWindow: true,
      capRaw: 5_000n,
      capScope: "NO_CAP",
      cooldownSeconds: 0,
      cooldownScope: "NONE",
      eoaOnlyActive: true,
      quoteAsset: ROBINHOOD_WETH_ADDRESS,
      curveStateHash: `curve-${blockNumber.toString()}`,
      evidenceIds: Object.freeze([`evidence-${blockNumber.toString()}`]),
    });

    const firstObservation = observation(100n, BLOCK_HASH);
    const firstDecision = orchestrator.observe(firstObservation, "L2", new Map()).at(0);
    if (firstDecision === undefined) throw new Error("canary was not selected");
    assert.equal(orchestrator.snapshot().at(0)?.state, "DISPATCHED");
    assert.equal(
      resolveQuotedLaneExpectedOutputForDispatch({
        orchestrator,
        quotes: new Map(),
        laneId: firstDecision.laneId,
      }),
      null,
    );
    assert.equal(orchestrator.snapshot().at(0)?.state, "DEFERRED");

    const secondBlockHash = `0x${"55".repeat(32)}` as const;
    const secondObservation = observation(101n, secondBlockHash);
    const secondQuote = createQuoteSnapshot({
      laneId: firstDecision.laneId,
      poolObservationId: secondObservation.observationId,
      profileRevision: 1,
      blockNumber: secondObservation.block.blockNumber,
      blockHash: secondObservation.block.blockHash,
      principalRaw: 5_000n,
      expectedTokenOutRaw: 888n,
      observedAtMs: 1_000_000,
      expiresAtMs: 2_000_000,
      evidenceIds: Object.freeze([secondObservation.observationId]),
    });
    const secondQuotes = new Map([[secondQuote.laneId, secondQuote]]);
    const secondDecision = orchestrator.observe(secondObservation, "L2", secondQuotes).at(0);
    assert.equal(secondDecision?.laneId, firstDecision.laneId);
    assert.equal(
      resolveQuotedLaneExpectedOutputForDispatch({
        orchestrator,
        quotes: secondQuotes,
        laneId: firstDecision.laneId,
      }),
      888n,
    );
    assert.equal(orchestrator.snapshot().at(0)?.state, "DISPATCHED");
  });

  it("reports entry enabled from remaining lane leases instead of requiring ten active leases", () => {
    const one = "0x4444444444444444444444444444444444444444" as const;
    const two = "0x5555555555555555555555555555555555555555" as const;
    assert.equal(
      quotedEntryEnabled({
        stopping: false,
        authorizationValid: true,
        remainingWalletAddresses: [two],
        activeLeaseAddresses: [two],
      }),
      true,
    );
    assert.equal(
      quotedEntryEnabled({
        stopping: false,
        authorizationValid: true,
        remainingWalletAddresses: [one, two],
        activeLeaseAddresses: [two],
      }),
      false,
    );
    assert.equal(
      quotedEntryEnabled({
        stopping: false,
        authorizationValid: true,
        remainingWalletAddresses: [],
        activeLeaseAddresses: [one, two],
      }),
      false,
    );
  });

  it("bounds Created-to-Armed waiting and treats every paid validity boundary as terminal", () => {
    const observedAtMs = Date.parse(NOW);
    assert.equal(
      safeLaunchArmedWaitDeadlineMs(NOW),
      observedAtMs + SAFE_LAUNCH_ARMED_WAIT_TIMEOUT_MS,
    );
    assert.doesNotThrow(() =>
      assertPaidExecutorLifecycleActive({
        ended: null,
        nowMs: observedAtMs + 1,
        authorizationExpiresAtMs: observedAtMs + 10_000,
        armed: false,
        armedWaitDeadlineMs: observedAtMs + 2,
        launchDeadlineMs: null,
        stage: "test",
      }),
    );
    assert.throws(
      () =>
        assertPaidExecutorLifecycleActive({
          ended: null,
          nowMs: observedAtMs + 2,
          authorizationExpiresAtMs: observedAtMs + 10_000,
          armed: false,
          armedWaitDeadlineMs: observedAtMs + 2,
          launchDeadlineMs: null,
          stage: "armed wait",
        }),
      (error: unknown) =>
        error instanceof PaidExecutorLifecycleEnded && error.reason === "ARMED_TIMEOUT",
    );
    assert.doesNotThrow(() =>
      assertPaidExecutorLifecycleActive({
        ended: null,
        nowMs: observedAtMs + 2,
        authorizationExpiresAtMs: observedAtMs + 10_000,
        armed: false,
        armedWaitDeadlineMs: observedAtMs + 2,
        launchDeadlineMs: null,
        recoveringExpiredArmedState: true,
        stage: "canonical Armed restart recovery",
      }),
    );
    assert.throws(
      () =>
        assertPaidExecutorLifecycleActive({
          ended: null,
          nowMs: observedAtMs + 10,
          authorizationExpiresAtMs: observedAtMs + 10,
          armed: true,
          armedWaitDeadlineMs: observedAtMs + 2,
          launchDeadlineMs: observedAtMs + 20,
          stage: "authorization",
        }),
      (error: unknown) =>
        error instanceof PaidExecutorLifecycleEnded && error.reason === "AUTHORIZATION_EXPIRED",
    );
    assert.throws(
      () =>
        assertPaidExecutorLifecycleActive({
          ended: null,
          nowMs: observedAtMs + 20,
          authorizationExpiresAtMs: observedAtMs + 30,
          armed: true,
          armedWaitDeadlineMs: observedAtMs + 2,
          launchDeadlineMs: observedAtMs + 20,
          stage: "launch window",
        }),
      (error: unknown) =>
        error instanceof PaidExecutorLifecycleEnded && error.reason === "LAUNCH_DEADLINE",
    );
    const revoked = new PaidExecutorLifecycleEnded("APPROVAL_REVOKED", "revoked");
    assert.throws(
      () =>
        assertPaidExecutorLifecycleActive({
          ended: revoked,
          nowMs: observedAtMs,
          authorizationExpiresAtMs: observedAtMs + 30,
          armed: true,
          armedWaitDeadlineMs: observedAtMs + 2,
          launchDeadlineMs: observedAtMs + 20,
          stage: "marker check",
        }),
      (error: unknown) => error === revoked,
    );
  });

  it("restores canonical effects before funding checks and only funds remaining lanes", () => {
    const quote = createQuoteSnapshot({
      laneId: "clockin-entry-01",
      poolObservationId: "observation-1",
      profileRevision: 1,
      blockNumber: 100n,
      blockHash: BLOCK_HASH,
      principalRaw: 5_000n,
      expectedTokenOutRaw: 10_000n,
      observedAtMs: 1,
      expiresAtMs: 10,
      evidenceIds: Object.freeze(["observation-1"]),
    });
    const plan = freezeQuotedEntryPlan({ draft: draft(), quote, minOutputRaw: 9_000n });
    const attempt = confirmedAttempt(plan);
    const effect = canonicalEffect(attempt);
    const recovered = selectQuotedLaneRecovery({
      laneId: plan.laneId,
      walletAddress: plan.walletAddress,
      plans: [plan],
      attempts: [attempt],
      effects: [effect],
    });
    assert.equal(recovered.state, "EFFECT_CONFIRMED");
    assert.doesNotThrow(() =>
      assertQuotedLaneRecoveryReadiness({
        recovery: recovered,
        readiness: readinessRow(),
        hasUnresolvedPersistentNonce: false,
      }),
    );
    assert.throws(
      () =>
        assertQuotedLaneRecoveryReadiness({
          recovery: recovered,
          readiness: readinessRow({ latestNonce: 0n, pendingNonce: 0n }),
          hasUnresolvedPersistentNonce: false,
        }),
      /effect and current nonce are inconsistent/,
    );
    const provisional = selectQuotedLaneRecovery({
      laneId: plan.laneId,
      walletAddress: plan.walletAddress,
      plans: [plan],
      attempts: [attempt],
      effects: [{ ...effect, canonicality: "PROVISIONAL" }],
    });
    assert.equal(provisional.state, "UNKNOWN");
    assert.throws(
      () =>
        selectQuotedLaneRecovery({
          laneId: plan.laneId,
          walletAddress: plan.walletAddress,
          plans: [plan],
          attempts: [attempt],
          effects: [],
        }),
      /terminal attempt without its canonical effect/,
    );

    const waiting = selectQuotedLaneRecovery({
      laneId: "clockin-entry-02",
      walletAddress: "0x5555555555555555555555555555555555555555",
      plans: [],
      attempts: [],
      effects: [],
    });
    assert.equal(waiting.state, "WAITING");
    assert.throws(
      () =>
        assertQuotedLaneRecoveryReadiness({
          recovery: waiting,
          readiness: readinessRow({
            walletId: "entry-02",
            address: waiting.walletAddress,
          }),
          hasUnresolvedPersistentNonce: false,
        }),
      /requires WETH, allowance, gas and a clean nonce/,
    );
    assert.equal(
      quotedRemainingLanesReady({
        lanes: [
          { walletId: "entry-01", state: "EFFECT_CONFIRMED" },
          { walletId: "entry-02", state: "WAITING" },
        ],
        readinessRows: [
          readinessRow(),
          readinessRow({
            walletId: "entry-02",
            address: waiting.walletAddress,
            nativeBalanceWei: 100n,
            wethBalanceRaw: 5_000n,
            wethAllowanceRaw: 5_000n,
            gasReady: true,
            wethReady: true,
            allowanceReady: true,
            ready: true,
          }),
        ],
        unresolvedWalletAddresses: [],
      }),
      true,
    );
  });

  it("rechecks both live markers immediately before signing and returns DROPPED_PROVEN to retry", async () => {
    const source = await readFile(
      new URL("../src/stonk-safe-launch-executor-service.ts", import.meta.url),
      "utf8",
    );
    const dispatch = source.indexOf("const dispatchLane = async");
    const signing = source.indexOf("signerBinding.signer.signTransaction", dispatch);
    const markerCheck = source.lastIndexOf("await assertLiveApprovals();", signing);
    const canonicalCheck = source.lastIndexOf("await assertCanonicalSafeLaunchCreated", signing);
    const handoffReorgCheck = source.lastIndexOf(
      "assertCanonicalCreatedMatchesPublicHandoff(handoff, canonicalCreated);",
      signing,
    );
    const freshQuoteCheck = source.lastIndexOf("await assertFreshCanonicalQuoteAndFee", signing);
    const activeHandoffCheck = source.lastIndexOf(
      "await assertCurrentPublicHandoffStillActive",
      signing,
    );
    const preBroadcastMarkerCheck = source.indexOf("await assertLiveApprovals();", signing);
    const possiblySubmitted = source.indexOf("possiblySubmitted = true", signing);
    assert.ok(dispatch >= 0);
    assert.ok(markerCheck > dispatch, "live marker check must be inside dispatch");
    assert.ok(signing > markerCheck, "live marker check must precede signing");
    assert.ok(
      canonicalCheck < markerCheck && signing > canonicalCheck,
      "canonical Created receipt/block/event check must precede the final marker and signing",
    );
    assert.ok(
      handoffReorgCheck > canonicalCheck && signing > handoffReorgCheck,
      "canonical Created block hash must still match the public handoff before signing",
    );
    assert.ok(
      freshQuoteCheck > handoffReorgCheck && activeHandoffCheck > freshQuoteCheck,
      "quote expiry, canonical block, base fee and current handoff must be revalidated before signing",
    );
    assert.ok(
      markerCheck > activeHandoffCheck && signing > markerCheck,
      "the live marker check must be the final awaited gate before local signing",
    );
    assert.ok(
      preBroadcastMarkerCheck > signing && preBroadcastMarkerCheck < possiblySubmitted,
      "live marker check must run again after signing and before possible submission",
    );
    assert.ok(
      possiblySubmitted > signing,
      "possibly-submitted begins only after signing and snapshot",
    );
    assert.match(source, /runtime approval marker revoked; aborting discovery and heads/u);
    assert.match(source, /throw new DroppedProvenLaneRetry/u);
    assert.match(source, /runtime\.orchestrator\.deferDispatchedLane\(decision\.laneId/u);
    assert.match(source, /startBlock: BigInt\(handoff\.created\.blockNumber\)/u);
    assert.match(source, /expectedCreated: handoff\.created/u);
    assert.match(
      source,
      /if \(error instanceof PublicLaunchHandoffSuperseded\) throw error/u,
      "handoff replacement must survive pre-broadcast cleanup and force service restart",
    );
    assert.match(source, /assertDiscoveryMatchesPublicHandoff\(handoff, discovered\.created\)/u);
    assert.doesNotMatch(source, /attempt\?\.state === "DROPPED_PROVEN"\s*\? \("FAILED_FINAL"/u);
  });
});
