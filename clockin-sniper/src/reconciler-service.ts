import { hostname } from "node:os";

import { ZeroAddress } from "ethers";

import { SameRawBroadcaster, type SameRawProvider } from "./broadcast/same-raw-broadcaster.js";
import { UnknownRecoveryManager } from "./broadcast/unknown-recovery.js";
import {
  stableHash,
  type EffectRecord,
  type ExecutionPlan,
  type ExitEffectRecord,
  type ExitPlan,
  type LaunchIdentity,
  type PositionLot,
  type TxAttempt,
} from "./core/canonical.js";
import { buildEntryEffect } from "./effects/entry-effect-builder.js";
import { buildExitEffect } from "./effects/exit-effect-builder.js";
import { SqliteStore } from "./persistence/sqlite-store.js";
import { HttpJsonRpcClient } from "./rpc/http-json-rpc.js";
import { assertPaidRpcApproved } from "./runtime/paid-rpc-approval.js";
import { hexToBigInt, quantityToHex } from "./rpc/hex.js";
import {
  loadProductionWalletManifest,
  loadVaultKey,
  readSystemdCredential,
} from "./runtime/credentials.js";
import {
  ProductionSameRawProvider,
  ProductionUnknownRecoveryProbe,
  readGenesisHash,
  readNativeBalance,
  readProductionReceipt,
  readTokenBalance,
  sumTokenTransfersTo,
} from "./runtime/production-rpc.js";
import { writeProductionServiceStatus } from "./runtime/service-status.js";
import {
  parseProductionBroadcastSnapshot,
  snapshotEventKind,
  type EntryBroadcastSnapshot,
  type ExitApprovalBroadcastSnapshot,
  type ExitSellBroadcastSnapshot,
  type ProductionBroadcastSnapshot,
} from "./runtime/transaction-snapshots.js";
import { SystemdWatchdog } from "./runtime/systemd-watchdog.js";
import { SignedTxVault } from "./wallets/signed-tx-vault.js";

const STRATEGY_ID = "clockin-mainnet-v1";
const STATUS_DIRECTORY = process.env.CLOCKIN_STATUS_DIR?.trim() || "/run/clockin-status";
const STATE_DIRECTORY = process.env.CLOCKIN_STATE_DIR?.trim() || "/var/lib/clockin-sniper";
const FINALITY_BLOCKS = 2n;
const UNKNOWN_REBROADCAST_BACKOFF_MS = 5_000;
const EXPIRED_RECHECK_BACKOFF_MS = 30_000;

function log(kind: "INFO" | "ACTION" | "ERROR", message: string, details: object = {}): void {
  process.stdout.write(
    `${JSON.stringify({ service: "clockin-reconciler", kind, message, ...details })}\n`,
  );
}

function recoverable(attempt: TxAttempt): boolean {
  return !["CONFIRMED_SUCCESS", "CONFIRMED_REVERTED", "DROPPED_PROVEN"].includes(attempt.state);
}

function attemptForRevision(attempt: TxAttempt, state: TxAttempt["state"]): TxAttempt {
  return Object.freeze({
    ...attempt,
    revision: attempt.revision + 1,
    state,
    updatedAt: new Date().toISOString(),
  });
}

function planForRevision(plan: ExitPlan, state: ExitPlan["state"]): ExitPlan {
  return Object.freeze({
    ...plan,
    revision: plan.revision + 1,
    state,
    updatedAt: new Date().toISOString(),
  });
}

async function main(): Promise<void> {
  const ownerId = process.env.CLOCKIN_RECONCILER_ID?.trim() || `clockin-reconciler:${hostname()}`;
  const watchdog = new SystemdWatchdog();
  await assertPaidRpcApproved();
  const [manifest, rpcHttp, sequencerHttp, vaultKey] = await Promise.all([
    loadProductionWalletManifest(),
    readSystemdCredential("rpc_http"),
    readSystemdCredential("sequencer_http"),
    loadVaultKey(),
  ]);
  const canonical = new HttpJsonRpcClient({
    providerId: "production-http",
    url: rpcHttp,
    timeoutMs: 5_000,
  });
  const sequencer = new HttpJsonRpcClient({
    providerId: "official-sequencer",
    url: sequencerHttp,
    timeoutMs: 2_000,
  });
  const store = new SqliteStore(`${STATE_DIRECTORY}/canonical.sqlite`);
  const vault = new SignedTxVault(`${STATE_DIRECTORY}/vault`, vaultKey);
  const genesisHash = await readGenesisHash(canonical);
  const candidates: SameRawProvider[] = [
    new ProductionSameRawProvider({
      requester: canonical,
      region: process.env.CLOCKIN_REGION?.trim() || "active-region",
      mode: "STANDARD",
      expectedGenesisHash: genesisHash,
    }),
    new ProductionSameRawProvider({
      requester: sequencer,
      region: "robinhood-sequencer",
      mode: "OFFICIAL_SEQUENCER",
      expectedGenesisHash: genesisHash,
    }),
  ];
  const available: SameRawProvider[] = [];
  for (const provider of candidates) {
    try {
      await provider.probeIdentity();
      available.push(provider);
    } catch (error) {
      log("ERROR", "same-raw recovery provider unavailable", {
        providerId: provider.providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (available.length === 0) throw new Error("no same-raw recovery provider is available");
  const broadcaster = new SameRawBroadcaster({
    providers: Object.freeze(available),
    expectedChainId: 4_663,
    expectedGenesisHash: genesisHash,
  });
  await broadcaster.preflight();
  const recoveryProbe = new ProductionUnknownRecoveryProbe(canonical);
  const recovery = new UnknownRecoveryManager({ probe: recoveryProbe, vault, broadcaster });
  let sequence = 0;
  let stopping = false;
  let working = false;

  const writeStatus = async (
    state: "BOOTING" | "WATCHING" | "READY" | "ACTIVE" | "DEGRADED" | "STOPPING" | "FAILED",
    details: readonly string[] = [],
  ): Promise<void> => {
    sequence += 1;
    const attempts = store.latestTxAttempts(STRATEGY_ID).filter(recoverable);
    await writeProductionServiceStatus(STATUS_DIRECTORY, {
      formatVersion: 1,
      service: "reconciler",
      state,
      pid: process.pid,
      ownerId,
      sequence,
      observedAt: new Date().toISOString(),
      signerReady: 0,
      database: Object.freeze({
        schemaVersion: store.schemaVersion(),
        walEnabled: store.walEnabled(),
        leaseOwned: true,
      }),
      entryEnabled: false,
      exitEnabled: true,
      unresolvedAttemptCount: attempts.length,
      openPositionCount: store.latestOpenPositionLots(STRATEGY_ID).length,
      verifiedExitRouteCount: 0,
      details: Object.freeze([...details]),
    });
  };

  const locateEntryPlan = (attempt: TxAttempt): ExecutionPlan => {
    const plan = store
      .latestExecutionPlans(STRATEGY_ID, attempt.launchId)
      .find((candidate) => candidate.planId === attempt.planId);
    if (plan === undefined) throw new Error(`attempt ${attempt.attemptId} has no entry plan`);
    return plan;
  };

  const locateExitPlan = (snapshot: ExitSellBroadcastSnapshot): ExitPlan => {
    const plan = store
      .latestExitPlans(STRATEGY_ID)
      .find((candidate) => candidate.exitPlanId === snapshot.exitPlanId);
    if (plan === undefined) throw new Error(`exit plan ${snapshot.exitPlanId} is missing`);
    if (
      plan.lotId !== snapshot.lotId ||
      plan.routeQuoteId !== snapshot.routeQuoteId ||
      plan.minOutputRaw !== snapshot.minimumQuoteOutputRaw
    ) {
      throw new Error("exit plan and pre-broadcast snapshot do not match");
    }
    return plan;
  };

  const locateIdentity = (attempt: TxAttempt): LaunchIdentity => {
    const identity = store
      .latestLaunchIdentities(STRATEGY_ID)
      .find((candidate) => candidate.launchId === attempt.launchId);
    if (identity === undefined) throw new Error(`attempt ${attempt.attemptId} has no identity`);
    return identity;
  };

  const locateLot = (attempt: TxAttempt, lotId: string): PositionLot => {
    const lot = store
      .latestPositionLots(STRATEGY_ID, attempt.launchId)
      .find((candidate) => candidate.lotId === lotId);
    if (lot === undefined) throw new Error(`exit attempt ${attempt.attemptId} has no position lot`);
    if (lot.walletAddress.toLowerCase() !== attempt.walletAddress.toLowerCase()) {
      throw new Error("exit attempt wallet does not own the canonical lot");
    }
    return lot;
  };

  const locateSnapshot = (attempt: TxAttempt): ProductionBroadcastSnapshot => {
    const event = store
      .auditEvents(STRATEGY_ID, attempt.launchId)
      .find(
        (candidate) =>
          candidate.objectId === attempt.attemptId &&
          [
            "ENTRY_PRE_BROADCAST_SNAPSHOT",
            "EXIT_APPROVAL_PRE_BROADCAST_SNAPSHOT",
            "EXIT_SELL_PRE_BROADCAST_SNAPSHOT",
          ].includes(candidate.eventKind),
      );
    if (event === undefined) {
      throw new Error(`attempt ${attempt.attemptId} has no pre-broadcast snapshot`);
    }
    const snapshot = parseProductionBroadcastSnapshot(event.payload);
    if (event.eventKind !== snapshotEventKind(snapshot)) {
      throw new Error("pre-broadcast snapshot kind does not match its audit event");
    }
    return snapshot;
  };

  const consumeNonceAndVault = async (
    attempt: TxAttempt,
    snapshot: ProductionBroadcastSnapshot,
  ): Promise<void> => {
    const slot = store.walletNonceSlot(attempt.walletAddress, BigInt(attempt.nonce));
    const [latestRaw, pendingRaw] = await Promise.all([
      canonical.request<string>("eth_getTransactionCount", [attempt.walletAddress, "latest"]),
      canonical.request<string>("eth_getTransactionCount", [attempt.walletAddress, "pending"]),
    ]);
    const latest = hexToBigInt("latest nonce", latestRaw);
    const pending = hexToBigInt("pending nonce", pendingRaw);
    if (latest <= BigInt(attempt.nonce) || pending <= BigInt(attempt.nonce)) {
      throw new Error("canonical receipt exists but wallet nonce readback has not advanced");
    }
    if (slot !== undefined && slot.state !== "CONSUMED") {
      store.updateWalletNonceSlot(slot, "CONSUMED", new Date().toISOString());
    }
    if (attempt.vaultRef !== undefined) {
      await vault.cleanup(attempt.vaultRef, {
        canonicalReceiptFinal: true,
        validityExpired: Date.now() > Date.parse(snapshot.validityExpiresAt),
        nonce: BigInt(attempt.nonce),
        latestNonce: latest,
        pendingNonce: pending,
        droppedProven: false,
      });
    }
  };

  const reconcileEntry = async (
    attempt: TxAttempt,
    snapshot: EntryBroadcastSnapshot,
    receipt: NonNullable<Awaited<ReturnType<typeof readProductionReceipt>>>,
  ): Promise<EffectRecord> => {
    const existing = store
      .latestEffectRecords(STRATEGY_ID, attempt.launchId)
      .find((effect) => effect.attemptId === attempt.attemptId);
    const plan = locateEntryPlan(attempt);
    const identity = locateIdentity(attempt);
    const [principalAfter, tokenAfter] = await Promise.all([
      readNativeBalance(canonical, attempt.walletAddress, receipt.blockNumber),
      readTokenBalance(
        canonical,
        identity.tokenAddress,
        attempt.walletAddress,
        receipt.blockNumber,
      ),
    ]);
    const built = buildEntryEffect({
      strategyId: STRATEGY_ID,
      intentId: attempt.intentId,
      attemptId: attempt.attemptId,
      launchId: attempt.launchId,
      laneId: attempt.laneId,
      walletAddress: attempt.walletAddress,
      tokenAddress: identity.tokenAddress,
      principalAsset: ZeroAddress as `0x${string}`,
      principalAssetKind: "NATIVE",
      entryRouteId: plan.adapterId,
      entryNonce: BigInt(attempt.nonce),
      expectedSignedTxHash: attempt.signedTxHash,
      receiptTxHash: receipt.transactionHash,
      receiptStatus: receipt.status,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      transactionIndex: receipt.transactionIndex,
      gasUsed: receipt.gasUsed,
      effectiveGasPriceRaw: receipt.effectiveGasPrice,
      principalBalanceBeforeRaw: BigInt(snapshot.principalBalanceBeforeRaw),
      principalBalanceAfterRaw: principalAfter,
      tokenBalanceBeforeRaw: BigInt(snapshot.tokenBalanceBeforeRaw),
      tokenBalanceAfterRaw: tokenAfter,
      transferLogTokenOutRaw: sumTokenTransfersTo(
        receipt,
        identity.tokenAddress,
        attempt.walletAddress,
      ),
      plannedPrincipalRaw: BigInt(snapshot.plannedPrincipalRaw),
      declaredFeeBps: plan.observedFeeBps,
      evidenceIds: Object.freeze([
        `receipt:${receipt.transactionHash}:${receipt.blockHash}`,
        snapshot.quoteId,
        plan.planHash,
      ]),
      observedAt: existing?.observedAt ?? new Date().toISOString(),
      finality: "CANONICAL",
    });
    if (existing === undefined) store.saveEffectRecord(built.effect);
    if (
      built.positionLot !== undefined &&
      !store
        .latestPositionLots(STRATEGY_ID, attempt.launchId)
        .some((lot) => lot.lotId === built.positionLot?.lotId)
    ) {
      store.savePositionLot(built.positionLot);
    }
    const auditEventId = `receipt-effect:${built.effect.effectId}`;
    if (
      !store
        .auditEvents(STRATEGY_ID, attempt.launchId)
        .some((event) => event.eventId === auditEventId)
    ) {
      store.appendAuditEvent({
        eventId: auditEventId,
        eventKind: "ENTRY_CANONICAL_EFFECT",
        strategyId: STRATEGY_ID,
        launchId: attempt.launchId,
        objectId: built.effect.effectId,
        parentEventId: `pre-broadcast:${attempt.attemptId}`,
        ...(built.effect.result === "REVERTED"
          ? { reasonCode: "RECEIPT_REVERTED" }
          : built.effect.result === "SUCCESS_NO_TOKENS"
            ? { reasonCode: "SUCCESS_NO_TOKENS" }
            : {}),
        payload: {
          txHash: built.effect.txHash,
          result: built.effect.result,
          canonicality: built.effect.canonicality,
          positionLotIds: built.effect.positionLotIds,
          gasCostRaw: built.gasCostRaw.toString(),
          tokenBalanceDeltaRaw: built.tokenBalanceDeltaRaw.toString(),
        },
        observedAt: built.effect.observedAt,
      });
    }
    store.settleReservationFromReceipt(
      plan.capitalReservationId,
      receipt.status === 1 ? "SUCCESS" : "REVERTED",
      new Date().toISOString(),
    );
    return existing ?? built.effect;
  };

  const reconcileApproval = (
    attempt: TxAttempt,
    snapshot: ExitApprovalBroadcastSnapshot,
    receipt: NonNullable<Awaited<ReturnType<typeof readProductionReceipt>>>,
  ): void => {
    const eventId = `exit-approval-receipt:${attempt.attemptId}`;
    if (
      store.auditEvents(STRATEGY_ID, attempt.launchId).some((event) => event.eventId === eventId)
    ) {
      return;
    }
    store.appendAuditEvent({
      eventId,
      eventKind: "EXIT_APPROVAL_CANONICAL",
      strategyId: STRATEGY_ID,
      launchId: attempt.launchId,
      objectId: snapshot.lotId,
      parentEventId: `pre-broadcast:${attempt.attemptId}`,
      ...(receipt.status === 0 ? { reasonCode: "RECEIPT_REVERTED" } : {}),
      payload: {
        txHash: receipt.transactionHash,
        receiptStatus: receipt.status,
        tokenAddress: snapshot.tokenAddress,
        spender: snapshot.spender,
        expectedAllowanceRaw: snapshot.expectedAllowanceRaw,
        gasCostRaw: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
      },
      observedAt: new Date().toISOString(),
    });
  };

  const reconcileExit = async (
    attempt: TxAttempt,
    snapshot: ExitSellBroadcastSnapshot,
    receipt: NonNullable<Awaited<ReturnType<typeof readProductionReceipt>>>,
  ): Promise<ExitEffectRecord> => {
    const receiptEvidenceId = `receipt:${receipt.transactionHash}:${receipt.blockHash}`;
    let lot = locateLot(attempt, snapshot.lotId);
    const plan = locateExitPlan(snapshot);
    const existing = store
      .latestEffectRecords(STRATEGY_ID, attempt.launchId)
      .find((effect) => effect.attemptId === attempt.attemptId) as ExitEffectRecord | undefined;
    let effect = existing;
    if (effect === undefined || !lot.evidenceIds.includes(receiptEvidenceId)) {
      const [tokenAfter, quoteAfter] = await Promise.all([
        readTokenBalance(canonical, lot.tokenAddress, attempt.walletAddress, receipt.blockNumber),
        snapshot.quoteAsset.toLowerCase() === ZeroAddress.toLowerCase()
          ? readNativeBalance(canonical, attempt.walletAddress, receipt.blockNumber)
          : readTokenBalance(
              canonical,
              snapshot.quoteAsset,
              attempt.walletAddress,
              receipt.blockNumber,
            ),
      ]);
      const built = buildExitEffect({
        strategyId: STRATEGY_ID,
        intentId: attempt.intentId,
        attemptId: attempt.attemptId,
        exitPlanId: snapshot.exitPlanId,
        launchId: attempt.launchId,
        laneId: attempt.laneId,
        lot,
        quoteAsset: snapshot.quoteAsset,
        expectedSignedTxHash: attempt.signedTxHash,
        receiptTxHash: receipt.transactionHash,
        receiptStatus: receipt.status,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        transactionIndex: receipt.transactionIndex,
        gasUsed: receipt.gasUsed,
        effectiveGasPriceRaw: receipt.effectiveGasPrice,
        tokenBalanceBeforeRaw: BigInt(snapshot.tokenBalanceBeforeRaw),
        tokenBalanceAfterRaw: tokenAfter,
        quoteBalanceBeforeRaw: BigInt(snapshot.quoteBalanceBeforeRaw),
        quoteBalanceAfterRaw: quoteAfter,
        expectedTokenInputRaw: BigInt(snapshot.expectedTokenInputRaw),
        evidenceIds: Object.freeze([receiptEvidenceId, snapshot.routeQuoteId, plan.exitPlanId]),
        observedAt: new Date().toISOString(),
        finality: "CANONICAL",
      });
      if (effect === undefined) store.saveEffectRecord(built.effect);
      if (!lot.evidenceIds.includes(receiptEvidenceId)) {
        store.savePositionLot(built.revisedLot);
        lot = built.revisedLot;
      }
      effect = built.effect;
    }
    const nextPlanState: ExitPlan["state"] =
      effect.result === "SUCCESS" && lot.state === "CLOSED"
        ? "COMPLETED"
        : effect.result === "PARTIAL" || effect.result === "SUCCESS"
          ? "PARTIALLY_COMPLETED"
          : "FAILED_RECOVERABLE";
    if (plan.state !== nextPlanState) store.saveExitPlan(planForRevision(plan, nextPlanState));
    const auditEventId = `exit-effect-receipt:${effect.effectId}`;
    if (
      !store
        .auditEvents(STRATEGY_ID, attempt.launchId)
        .some((event) => event.eventId === auditEventId)
    ) {
      store.appendAuditEvent({
        eventId: auditEventId,
        eventKind: "EXIT_CANONICAL_EFFECT",
        strategyId: STRATEGY_ID,
        launchId: attempt.launchId,
        objectId: effect.effectId,
        parentEventId: `pre-broadcast:${attempt.attemptId}`,
        ...(receipt.status === 0 ? { reasonCode: "RECEIPT_REVERTED" } : {}),
        payload: {
          txHash: effect.txHash,
          result: effect.result,
          settlement: effect.settlement,
          gasCostRaw: effect.gasCostRaw.state === "KNOWN" ? effect.gasCostRaw.value : null,
          actualOutputRaw:
            effect.actualOutputRaw.state === "KNOWN" ? effect.actualOutputRaw.value : null,
          remainingRaw: lot.remainingRaw,
        },
        observedAt: effect.observedAt,
      });
    }
    return effect;
  };

  const finalizeReceipt = async (attempt: TxAttempt): Promise<boolean> => {
    const receipt = await readProductionReceipt(canonical, attempt.signedTxHash);
    if (receipt === null) return false;
    const head = hexToBigInt("eth_blockNumber", await canonical.request<string>("eth_blockNumber"));
    if (head < receipt.blockNumber + FINALITY_BLOCKS) {
      if (attempt.state !== "INCLUDED")
        store.saveTxAttempt(attemptForRevision(attempt, "INCLUDED"));
      return true;
    }
    const block = await canonical.request<{ readonly hash?: unknown } | null>(
      "eth_getBlockByNumber",
      [quantityToHex(receipt.blockNumber), false],
    );
    if (
      block === null ||
      typeof block.hash !== "string" ||
      block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
    ) {
      throw new Error("receipt block is no longer canonical");
    }
    const snapshot = locateSnapshot(attempt);
    let result: string = snapshot.kind;
    if (snapshot.kind === "ENTRY_BUY") {
      result = (await reconcileEntry(attempt, snapshot, receipt)).result;
    } else if (snapshot.kind === "EXIT_APPROVAL") {
      reconcileApproval(attempt, snapshot, receipt);
      result = receipt.status === 1 ? "APPROVED" : "REVERTED";
    } else {
      result = (await reconcileExit(attempt, snapshot, receipt)).result;
    }
    const finalState: TxAttempt["state"] =
      receipt.status === 1 ? "CONFIRMED_SUCCESS" : "CONFIRMED_REVERTED";
    await consumeNonceAndVault(attempt, snapshot);
    if (attempt.state !== finalState) store.saveTxAttempt(attemptForRevision(attempt, finalState));
    log("ACTION", "canonical transaction effect reconciled", {
      attemptId: attempt.attemptId,
      txHash: attempt.signedTxHash,
      operation: snapshot.kind,
      result,
    });
    return true;
  };

  const recoverUnknown = async (attempt: TxAttempt): Promise<void> => {
    const nowMs = Date.now();
    const ageMs = Math.max(0, nowMs - Date.parse(attempt.updatedAt));
    if (
      (attempt.state === "UNKNOWN" && ageMs < UNKNOWN_REBROADCAST_BACKOFF_MS) ||
      (attempt.state === "EXPIRED_UNRESOLVED" && ageMs < EXPIRED_RECHECK_BACKOFF_MS)
    ) {
      return;
    }
    const snapshot = locateSnapshot(attempt);
    const probe = await recoveryProbe.snapshot(attempt.walletAddress, attempt.signedTxHash);
    if (probe.receipt !== null || probe.transactionKnown) return;
    const unknown =
      attempt.state === "UNKNOWN"
        ? attempt
        : Object.freeze({ ...attempt, state: "UNKNOWN" as const });
    const result = await recovery.recover(unknown, Date.parse(snapshot.validityExpiresAt), nowMs);
    const latest = store
      .latestTxAttempts(STRATEGY_ID, attempt.launchId)
      .find((candidate) => candidate.attemptId === attempt.attemptId);
    if (latest === undefined) throw new Error("recovery attempt disappeared from canonical store");
    const nextState: TxAttempt["state"] =
      result.state === "EXPIRED_UNRESOLVED" ? "EXPIRED_UNRESOLVED" : "UNKNOWN";
    if (latest.state !== nextState || result.state === "REBROADCASTED") {
      store.saveTxAttempt(attemptForRevision(latest, nextState));
    }
    log("INFO", "same-raw recovery evaluated", {
      attemptId: attempt.attemptId,
      txHash: attempt.signedTxHash,
      recoveryState: result.state,
    });
  };

  const tick = async (): Promise<void> => {
    if (working || stopping) return;
    working = true;
    const failures: string[] = [];
    try {
      const attempts = store.latestTxAttempts(STRATEGY_ID).filter(recoverable);
      for (const attempt of attempts) {
        try {
          if (!(await finalizeReceipt(attempt))) await recoverUnknown(attempt);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${attempt.attemptId}:${message}`);
          log("ERROR", "transaction reconciliation failed closed", {
            attemptId: attempt.attemptId,
            error: message,
          });
        }
      }
      await writeStatus(
        failures.length === 0 ? (attempts.length === 0 ? "READY" : "ACTIVE") : "DEGRADED",
        failures,
      );
    } finally {
      working = false;
    }
  };

  await writeStatus("READY", [`WALLETS_${manifest.entries.length}`, "SAME_RAW_RECOVERY_READY"]);
  await watchdog.ready("reconciler ready");
  await tick();
  const timer = setInterval(() => void tick(), 1_000);
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    while (working) await new Promise((resolve) => setTimeout(resolve, 25));
    await writeStatus("STOPPING", [signal]);
    await watchdog.stopping(`reconciler stopping after ${signal}`);
    store.close();
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      service: "clockin-reconciler",
      state: "FAILED",
      error: error instanceof Error ? error.message : String(error),
      errorId: stableHash(error instanceof Error ? error.message : String(error)),
    })}\n`,
  );
  process.exitCode = 1;
});
