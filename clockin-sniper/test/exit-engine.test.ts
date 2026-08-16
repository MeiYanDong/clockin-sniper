import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  assertExecutableRouteProfile,
  type VerifiedRouteProfile,
} from "../src/adapters/sell-adapter.js";
import type { Address, Hex32, PositionLot, RouteQuote } from "../src/core/canonical.js";
import {
  buildEntryEffect,
  type EntryReceiptEvidence,
} from "../src/effects/entry-effect-builder.js";
import { buildExitEffect } from "../src/effects/exit-effect-builder.js";
import { EntryExitControl } from "../src/exit/entry-exit-control.js";
import {
  decidePrePrincipalDownside,
  type DownsidePolicyConfig,
  type DownsidePolicyState,
} from "../src/exit/downside-policy.js";
import { buildExitPlan } from "../src/exit/exit-plan-builder.js";
import { decidePrincipalFirstExit, type ExitPolicyConfig } from "../src/exit/principal-recovery.js";
import { ExternalRouteRegistry, type ExternalRouteCandidate } from "../src/exit/route-registry.js";
import { createNetRouteQuote, selectBestExecutableRoute } from "../src/exit/route-quote.js";
import { SqliteStore } from "../src/persistence/sqlite-store.js";
import { aggregatePosition, reconcileLotBalance } from "../src/positions/position-book.js";

const NOW = "2026-08-16T00:00:00.000Z";
const LATER = "2026-08-16T00:01:00.000Z";
const EXPIRES = "2026-08-16T00:02:00.000Z";
const TOKEN = `0x${"11".repeat(20)}` as Address;
const QUOTE_ASSET = `0x${"22".repeat(20)}` as Address;
const WALLET_1 = `0x${"33".repeat(20)}` as Address;
const WALLET_2 = `0x${"44".repeat(20)}` as Address;
const POOL = `0x${"55".repeat(20)}` as Address;
const ROUTER = `0x${"66".repeat(20)}` as Address;
const FACTORY = `0x${"77".repeat(20)}` as Address;
const TX_1 = `0x${"88".repeat(32)}` as Hex32;
const TX_2 = `0x${"89".repeat(32)}` as Hex32;
const BLOCK_HASH = `0x${"99".repeat(32)}` as Hex32;
const FACTORY_HASH = `0x${"aa".repeat(32)}` as Hex32;
const ROUTER_HASH = `0x${"bb".repeat(32)}` as Hex32;
const POOL_HASH = `0x${"cc".repeat(32)}` as Hex32;

function entryEvidence(
  laneId: string,
  walletAddress: Address,
  txHash: Hex32,
  observedAt = NOW,
): EntryReceiptEvidence {
  return {
    strategyId: "clockin",
    intentId: `intent-${laneId}`,
    attemptId: `attempt-${laneId}`,
    launchId: "launch-1",
    laneId,
    walletAddress,
    tokenAddress: TOKEN,
    principalAsset: QUOTE_ASSET,
    principalAssetKind: "NATIVE",
    entryRouteId: "launch-pool-v1",
    expectedSignedTxHash: txHash,
    receiptTxHash: txHash,
    receiptStatus: 1,
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    transactionIndex: BigInt(laneId.slice(-1)),
    gasUsed: 10n,
    effectiveGasPriceRaw: 10n,
    principalBalanceBeforeRaw: 10_000n,
    principalBalanceAfterRaw: 4_900n,
    tokenBalanceBeforeRaw: 0n,
    tokenBalanceAfterRaw: 1_000n,
    transferLogTokenOutRaw: 1_000n,
    plannedPrincipalRaw: 5_000n,
    declaredFeeBps: 4_000,
    evidenceIds: [`receipt-${laneId}`],
    observedAt,
    finality: "CANONICAL",
  };
}

function lots(): readonly [PositionLot, PositionLot] {
  return [
    buildEntryEffect(entryEvidence("lane-1", WALLET_1, TX_1, NOW)).positionLot as PositionLot,
    buildEntryEffect(entryEvidence("lane-2", WALLET_2, TX_2, LATER)).positionLot as PositionLot,
  ];
}

function routeQuote(
  lot: PositionLot,
  netOutputRaw = 12_000n,
  routeId = "launch-route",
): RouteQuote {
  return createNetRouteQuote({
    strategyId: lot.strategyId,
    launchId: lot.launchId,
    revision: 1,
    lotId: lot.lotId,
    routeId,
    routeKind: routeId.startsWith("external") ? "EXTERNAL_AMM" : "LAUNCH_POOL",
    tokenInputRaw: BigInt(lot.remainingRaw),
    grossOutputRaw: netOutputRaw + 1_000n,
    sellTaxRaw: 400n,
    priceImpactRaw: 300n,
    approvalGasRaw: 100n,
    executionGasRaw: 200n,
    quoteBlock: 101n,
    observedAt: LATER,
    expiresAt: EXPIRES,
    evidenceIds: [`quote-${lot.lotId}`],
  });
}

describe("position lots and executable liquidation", () => {
  it("aggregates canonical wallet lots without losing unvalued residuals", () => {
    const [first, second] = lots();
    const firstQuote = routeQuote(first);
    const result = aggregatePosition({
      lots: [first, second],
      quotesByLotId: new Map([[first.lotId, firstQuote]]),
      realizedProceedsRaw: 500n,
      observedAt: LATER,
    });
    assert.equal(result.position.totalQuantityRaw, "2000");
    assert.equal(result.position.remainingQuantityRaw, "2000");
    assert.equal(result.position.totalActualCostRaw, "10200");
    assert.equal(result.position.realizedProceedsRaw, "500");
    assert.equal(
      result.position.executableNetLiquidationRaw.state === "KNOWN"
        ? result.position.executableNetLiquidationRaw.value
        : undefined,
      "12000",
    );
    assert.deepEqual(result.unvaluedLotIds, [second.lotId]);
    assert.equal(first.entryNonce.state, "UNKNOWN");
    assert.equal(first.allowanceRaw.state, "UNKNOWN");
    assert.equal(first.pendingNonce.state, "UNKNOWN");
  });

  it("marks a wallet lot UNKNOWN when chain balance no longer matches canonical remainder", () => {
    const [first] = lots();
    assert.equal(reconcileLotBalance(first, 1_000n, LATER, "balance").revision, first.revision);
    const mismatched = reconcileLotBalance(first, 999n, LATER, "balance-mismatch");
    assert.equal(mismatched.state, "UNKNOWN");
    assert.equal(mismatched.remainingRaw, "1000");
  });
});

describe("verified launch/external routes and net quotes", () => {
  const candidate: ExternalRouteCandidate = {
    routeId: "external-v1",
    chainId: 4_663,
    tokenAddress: TOKEN,
    quoteAsset: QUOTE_ASSET,
    poolAddress: POOL,
    routerAddress: ROUTER,
    factoryAddress: FACTORY,
    factoryCodeHash: FACTORY_HASH,
    routerCodeHash: ROUTER_HASH,
    poolCodeHash: POOL_HASH,
    feeTierBps: 30,
    liquidityRaw: 1_000_000n,
    currentSellQuoteRaw: 12_000n,
    allowanceMode: "APPROVE",
    finalizeEvidenceId: "finalize-receipt",
    evidenceIds: ["factory-code", "router-code", "reserves", "sell-quote"],
  };

  it("requires finalize, allowlisted code identity, token/quote match, liquidity and sell quote", () => {
    const registry = new ExternalRouteRegistry();
    const allowlist = {
      chainId: 4_663,
      tokenAddress: TOKEN,
      quoteAsset: QUOTE_ASSET,
      factoryCodeHashes: new Set([FACTORY_HASH.toLowerCase()]),
      routerCodeHashes: new Set([ROUTER_HASH.toLowerCase()]),
    };
    const profile = registry.verify(candidate, allowlist, NOW);
    assert.equal(profile.state, "VERIFIED");
    assertExecutableRouteProfile(profile, "EXTERNAL_AMM", TOKEN);
    assert.equal(registry.verify(candidate, allowlist, NOW).revision, 1);
    assert.equal(registry.markStale(profile.routeId, LATER, "route-removed").revision, 2);
    assert.throws(
      () => registry.verify({ ...candidate, routeId: "empty", liquidityRaw: 0n }, allowlist, NOW),
      /PairCreated/,
    );
    assert.throws(
      () =>
        registry.verify(
          { ...candidate, routeId: "wrong-code", factoryCodeHash: BLOCK_HASH },
          allowlist,
          NOW,
        ),
      /allowlisted/,
    );
  });

  it("subtracts tax, impact and both gas legs and chooses only a fresh positive best route", () => {
    const [lot] = lots();
    const launch = routeQuote(lot, 12_000n, "launch-route");
    const external = routeQuote(lot, 13_000n, "external-route");
    assert.equal(launch.netOutputRaw, "12000");
    assert.equal(selectBestExecutableRoute([launch, external], LATER)?.routeId, "external-route");
    assert.equal(selectBestExecutableRoute([launch], "2026-08-16T00:03:00.000Z"), null);
  });

  it("fails closed for an unavailable, zero-liquidity or wrong-token route profile", () => {
    const profile: VerifiedRouteProfile = {
      routeId: "launch-route",
      revision: 1,
      routeKind: "LAUNCH_POOL",
      state: "VERIFIED",
      chainId: 4_663,
      tokenAddress: TOKEN,
      quoteAsset: QUOTE_ASSET,
      poolAddress: POOL,
      routerAddress: ROUTER,
      factoryAddress: FACTORY,
      factoryCodeHash: FACTORY_HASH,
      routerCodeHash: ROUTER_HASH,
      poolCodeHash: POOL_HASH,
      feeTierBps: 4_000,
      liquidityRaw: 1n,
      allowanceMode: "APPROVE",
      evidenceIds: ["verified-profile"],
      verifiedAt: NOW,
    };
    assertExecutableRouteProfile(profile, "LAUNCH_POOL", TOKEN);
    assert.throws(
      () => assertExecutableRouteProfile({ ...profile, liquidityRaw: 0n }, "LAUNCH_POOL", TOKEN),
      /zero/,
    );
    assert.throws(
      () =>
        assertExecutableRouteProfile({ ...profile, state: "UNAVAILABLE" }, "LAUNCH_POOL", TOKEN),
      /not verified/,
    );
  });
});

describe("principal-first exit policy", () => {
  const config: ExitPolicyConfig = {
    recoverPrincipalMultipleBps: 20_000,
    secondProfitMultipleBps: 30_000,
    secondProfitTokenShareBps: 1_000,
    runnerDrawdownBps: 2_500,
    runnerMaximumHoldingMs: 60_000,
    momentumFailurePolicyId: "DISABLED_UNTIL_REPLAY_V1",
  };

  function positionWithQuotes(netEach: bigint) {
    const [first, second] = lots();
    const quotes = new Map([
      [first.lotId, routeQuote(first, netEach, "launch-1")],
      [second.lotId, routeQuote(second, netEach, "launch-2")],
    ]);
    const position = aggregatePosition({
      lots: [first, second],
      quotesByLotId: quotes,
      realizedProceedsRaw: 0n,
      observedAt: LATER,
    }).position;
    return { lots: [first, second] as const, quotes, position };
  }

  it("at 2x solves the minimum oldest-lot token input required to recover actual cost", () => {
    const state = positionWithQuotes(12_000n);
    const decision = decidePrincipalFirstExit({
      ...state,
      quotesByLotId: state.quotes,
      actualRecoveredProceedsRaw: 0n,
      initialTotalTokenRaw: 2_000n,
      runner: { executableNetPeakRaw: 0n, positionOpenedAtMs: 0, momentumFailed: false },
      nowMs: 1_000,
      config,
    });
    assert.equal(decision.stage, "RECOVER_PRINCIPAL");
    assert.equal(decision.instructions.length, 1);
    assert.equal(decision.instructions[0]?.lotId, state.lots[0].lotId);
    assert.equal(decision.instructions[0]?.tokenInputRaw, 850n);
    assert.equal(decision.instructions[0]?.expectedNetOutputRaw, 10_200n);
  });

  it("ignores unvalidated momentum signals while the replay-gated policy is disabled", () => {
    const state = positionWithQuotes(4_000n);
    const decision = decidePrincipalFirstExit({
      ...state,
      quotesByLotId: state.quotes,
      actualRecoveredProceedsRaw: BigInt(state.position.totalActualCostRaw),
      initialTotalTokenRaw: 2_000n,
      runner: { executableNetPeakRaw: 8_000n, positionOpenedAtMs: 0, momentumFailed: true },
      nowMs: 1_000,
      config,
    });
    assert.equal(decision.stage, "HOLD");
    assert.equal(decision.instructions.length, 0);
  });

  it("uses actual recovered proceeds for 3x second profit and sells 10% of initial tokens", () => {
    const state = positionWithQuotes(12_000n);
    const decision = decidePrincipalFirstExit({
      ...state,
      quotesByLotId: state.quotes,
      actualRecoveredProceedsRaw: 10_200n,
      initialTotalTokenRaw: 2_000n,
      runner: { executableNetPeakRaw: 24_000n, positionOpenedAtMs: 0, momentumFailed: false },
      nowMs: 1_000,
      config,
    });
    assert.equal(decision.stage, "TAKE_SECOND_PROFIT");
    assert.equal(
      decision.instructions.reduce((sum, item) => sum + item.tokenInputRaw, 0n),
      200n,
    );
  });

  it("exits the runner on an executable-net drawdown", () => {
    const state = positionWithQuotes(3_000n);
    const decision = decidePrincipalFirstExit({
      ...state,
      quotesByLotId: state.quotes,
      actualRecoveredProceedsRaw: 10_200n,
      initialTotalTokenRaw: 2_000n,
      runner: { executableNetPeakRaw: 10_000n, positionOpenedAtMs: 0, momentumFailed: false },
      nowMs: 1_000,
      config,
    });
    assert.equal(decision.stage, "RUNNER");
    assert.match(decision.trigger, /drawdown/);
    assert.equal(
      decision.instructions.reduce((sum, item) => sum + item.tokenInputRaw, 0n),
      2_000n,
    );
  });
});

describe("pre-principal downside policy", () => {
  const config: DownsidePolicyConfig = {
    initialStopLossBps: 3_000,
    stopLossConfirmationBlocks: 2,
    prePrincipalMaximumHoldingMs: 3_600_000,
    noLiquidityPolicy: "ALERT_AND_RETRY_VERIFIED_ROUTES",
  };
  const state: DownsidePolicyState = {
    positionOpenedAtMs: 0,
    postEntryExecutableNetBaselineRaw: 10_000n,
    lastCanonicalBlockNumber: null,
    consecutiveBelowStopBlocks: 0,
  };

  it("requires two distinct consecutive canonical blocks below the post-entry net baseline", () => {
    const first = decidePrePrincipalDownside({
      actualRecoveredProceedsRaw: 0n,
      actualCostRaw: 10_000n,
      executableNetLiquidationRaw: 7_000n,
      executableRouteCount: 1,
      feeWindowClosed: true,
      canonicalBlockNumber: 100n,
      nowMs: 1_000,
      state,
      config,
    });
    assert.equal(first.action, "HOLD");
    assert.equal(first.stopThresholdRaw, 7_000n);
    assert.equal(first.updatedState.consecutiveBelowStopBlocks, 1);
    const duplicate = decidePrePrincipalDownside({
      actualRecoveredProceedsRaw: 0n,
      actualCostRaw: 10_000n,
      executableNetLiquidationRaw: 6_500n,
      executableRouteCount: 1,
      feeWindowClosed: true,
      canonicalBlockNumber: 100n,
      nowMs: 1_100,
      state: first.updatedState,
      config,
    });
    assert.equal(duplicate.action, "HOLD");
    assert.equal(duplicate.updatedState.consecutiveBelowStopBlocks, 1);
    const confirmed = decidePrePrincipalDownside({
      actualRecoveredProceedsRaw: 0n,
      actualCostRaw: 10_000n,
      executableNetLiquidationRaw: 6_999n,
      executableRouteCount: 1,
      feeWindowClosed: true,
      canonicalBlockNumber: 101n,
      nowMs: 2_000,
      state: duplicate.updatedState,
      config,
    });
    assert.equal(confirmed.action, "EXIT_ALL");
  });

  it("does not sample stop loss during the fee window and exits after the 60-minute bound", () => {
    const duringWindow = decidePrePrincipalDownside({
      actualRecoveredProceedsRaw: 0n,
      actualCostRaw: 10_000n,
      executableNetLiquidationRaw: 5_000n,
      executableRouteCount: 1,
      feeWindowClosed: false,
      canonicalBlockNumber: 100n,
      nowMs: 120_000,
      state,
      config,
    });
    assert.equal(duringWindow.action, "HOLD");
    assert.equal(duringWindow.updatedState.consecutiveBelowStopBlocks, 0);
    const timedOut = decidePrePrincipalDownside({
      actualRecoveredProceedsRaw: 0n,
      actualCostRaw: 10_000n,
      executableNetLiquidationRaw: 8_000n,
      executableRouteCount: 1,
      feeWindowClosed: true,
      canonicalBlockNumber: 101n,
      nowMs: 3_600_000,
      state,
      config,
    });
    assert.equal(timedOut.action, "EXIT_ALL");
    assert.match(timedOut.reason, /maximum holding time/);
  });

  it("alerts without widening slippage when no verified executable route exists", () => {
    const missing = decidePrePrincipalDownside({
      actualRecoveredProceedsRaw: 0n,
      actualCostRaw: 10_000n,
      executableNetLiquidationRaw: null,
      executableRouteCount: 0,
      feeWindowClosed: true,
      canonicalBlockNumber: 100n,
      nowMs: 3_600_000,
      state,
      config,
    });
    assert.equal(missing.action, "ALERT_AND_RETRY_VERIFIED_ROUTES");
    assert.match(missing.reason, /do not widen slippage automatically/);
  });
});

describe("exit plan, effect, independent control and restart", () => {
  it("builds a fresh quote-bounded plan and reconciles actual quote proceeds", () => {
    const [lot] = lots();
    const quote = routeQuote(lot);
    const position = aggregatePosition({
      lots: [lot],
      quotesByLotId: new Map([[lot.lotId, quote]]),
      realizedProceedsRaw: 0n,
      observedAt: LATER,
    }).position;
    const plan = buildExitPlan({
      position,
      lot,
      quote,
      tokenInputRaw: 400n,
      policyStage: "RECOVER_PRINCIPAL",
      maximumSlippageBps: 500,
      validityEnvelopeId: "validity-1",
      now: LATER,
    });
    assert.equal(plan.minOutputRaw, "4560");
    const effect = buildExitEffect({
      strategyId: "clockin",
      intentId: "exit-intent-1",
      attemptId: "exit-attempt-1",
      exitPlanId: plan.exitPlanId,
      launchId: lot.launchId,
      laneId: lot.laneId,
      lot,
      quoteAsset: QUOTE_ASSET,
      expectedSignedTxHash: TX_2,
      receiptTxHash: TX_2,
      receiptStatus: 1,
      blockNumber: 102n,
      blockHash: BLOCK_HASH,
      transactionIndex: 3n,
      gasUsed: 10n,
      effectiveGasPriceRaw: 10n,
      tokenBalanceBeforeRaw: 1_000n,
      tokenBalanceAfterRaw: 600n,
      quoteBalanceBeforeRaw: 100n,
      quoteBalanceAfterRaw: 4_900n,
      expectedTokenInputRaw: 400n,
      evidenceIds: ["exit-receipt", "quote-balance"],
      observedAt: EXPIRES,
      finality: "CANONICAL",
    });
    assert.equal(effect.effect.result, "SUCCESS");
    assert.equal(effect.actualQuoteProceedsRaw, 4_800n);
    assert.equal(effect.revisedLot.remainingRaw, "600");
    assert.equal(effect.revisedLot.state, "PARTIALLY_EXITED");
  });

  it("keeps exit active and auditable after entry is stopped", () => {
    const control = new EntryExitControl(true, true);
    control.stopEntry("profile drift stopped unsent entry lanes");
    const snapshot = control.snapshot(2);
    assert.equal(snapshot.entryEnabled, false);
    assert.equal(snapshot.exitEnabled, true);
    assert.equal(snapshot.exitServiceRequired, true);
    assert.doesNotThrow(() => control.assertExitAllowed());
    const audit = control.authorizeExitNow({
      operatorId: "operator-1",
      lotId: "lot-1",
      routeQuoteId: "quote-1",
      maximumSlippageBps: 500,
      observedAt: NOW,
    });
    assert.equal(audit.eventKind, "MANUAL_EXIT_NOW");
    const [lot] = lots();
    const quote = routeQuote(lot);
    const position = aggregatePosition({
      lots: [lot],
      quotesByLotId: new Map([[lot.lotId, quote]]),
      realizedProceedsRaw: 0n,
      observedAt: LATER,
    }).position;
    assert.doesNotThrow(() =>
      buildExitPlan({
        position,
        lot,
        quote,
        tokenInputRaw: 100n,
        policyStage: "EXIT_NOW",
        maximumSlippageBps: 500,
        validityEnvelopeId: "validity-after-entry-stop",
        now: LATER,
      }),
    );
  });

  it("separates routine 5% exits from explicit twice-confirmed 20% break-glass exits", () => {
    const control = new EntryExitControl();
    assert.throws(
      () =>
        control.authorizeExitNow({
          operatorId: "operator-1",
          lotId: "lot-1",
          routeQuoteId: "quote-routine",
          maximumSlippageBps: 501,
          observedAt: NOW,
        }),
      /routine exit exceeds/,
    );
    const breakGlass = control.authorizeBreakGlassExit({
      operatorId: "operator-1",
      lotId: "lot-1",
      routeQuoteId: "quote-break-glass",
      maximumSlippageBps: 2_000,
      secondConfirmationId: "confirmation-2",
      justification: "verified route exists but routine bound cannot execute",
      observedAt: NOW,
    });
    assert.equal(breakGlass.eventKind, "BREAK_GLASS_EXIT");
    assert.equal(breakGlass.maximumSlippageBps, 2_000);
    const [lot] = lots();
    const quote = routeQuote(lot);
    const position = aggregatePosition({
      lots: [lot],
      quotesByLotId: new Map([[lot.lotId, quote]]),
      realizedProceedsRaw: 0n,
      observedAt: LATER,
    }).position;
    const plan = buildExitPlan({
      position,
      lot,
      quote,
      tokenInputRaw: 100n,
      policyStage: "BREAK_GLASS",
      maximumSlippageBps: 2_000,
      validityEnvelopeId: "break-glass-validity",
      breakGlassAuthorizationId: breakGlass.eventId,
      now: LATER,
    });
    assert.equal(plan.breakGlassAuthorizationId, breakGlass.eventId);
    assert.throws(
      () =>
        buildExitPlan({
          position,
          lot,
          quote,
          tokenInputRaw: 100n,
          policyStage: "EXIT_NOW",
          maximumSlippageBps: 2_000,
          validityEnvelopeId: "routine-cannot-escalate",
          now: LATER,
        }),
      /routine exit plan exceeds/,
    );
    assert.throws(
      () =>
        control.authorizeBreakGlassExit({
          operatorId: "operator-1",
          lotId: "lot-1",
          routeQuoteId: "quote-break-glass",
          maximumSlippageBps: 2_000,
          secondConfirmationId: "",
          justification: "verified route exists",
          observedAt: NOW,
        }),
      /second confirmation/,
    );
    assert.throws(
      () =>
        control.authorizeBreakGlassExit({
          operatorId: "operator-1",
          lotId: "lot-1",
          routeQuoteId: "quote-break-glass",
          maximumSlippageBps: 2_001,
          secondConfirmationId: "confirmation-2",
          justification: "verified route exists",
          observedAt: NOW,
        }),
      /break-glass exit exceeds/,
    );
  });

  it("keeps exit draining and reports every residual position on global shutdown", () => {
    const control = new EntryExitControl(true, false);
    const draining = control.requestGlobalShutdown(
      ["position-1", "position-2"],
      "operator shutdown",
    );
    assert.equal(draining.state, "DRAINING_POSITIONS");
    assert.equal(draining.exitEnabled, true);
    assert.deepEqual(draining.residualPositionIds, ["position-1", "position-2"]);
    assert.equal(control.snapshot(2).exitServiceRequired, true);
    assert.equal(
      new EntryExitControl().requestGlobalShutdown([], "clean shutdown").state,
      "STOPPED",
    );
  });

  it("restores latest effect and wallet-level position revisions from SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clockin-exit-store-"));
    const databasePath = join(directory, "state.sqlite");
    try {
      const [lot] = lots();
      const entry = buildEntryEffect(entryEvidence("lane-1", WALLET_1, TX_1, NOW));
      const quote = routeQuote(lot);
      const position = aggregatePosition({
        lots: [lot],
        quotesByLotId: new Map([[lot.lotId, quote]]),
        realizedProceedsRaw: 0n,
        observedAt: LATER,
      }).position;
      const exitPlan = buildExitPlan({
        position,
        lot,
        quote,
        tokenInputRaw: 100n,
        policyStage: "EXIT_NOW",
        maximumSlippageBps: 500,
        validityEnvelopeId: "validity",
        now: LATER,
      });
      const store = new SqliteStore(databasePath);
      store.saveEffectRecord(entry.effect);
      store.savePositionLot(lot);
      store.saveRouteQuote(quote);
      store.saveExitPlan(exitPlan);
      store.close();

      const reopened = new SqliteStore(databasePath);
      assert.equal(
        reopened.latestEffectRecords("clockin", "launch-1")[0]?.effectId,
        entry.effect.effectId,
      );
      assert.equal(reopened.latestPositionLots("clockin", "launch-1")[0]?.walletAddress, WALLET_1);
      assert.equal(reopened.tableCount("route_quotes"), 1);
      assert.equal(reopened.tableCount("exit_plans"), 1);
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
