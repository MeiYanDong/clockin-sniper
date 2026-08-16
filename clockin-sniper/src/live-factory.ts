import { Wallet, getAddress, keccak256 } from "ethers";

import type { DispatchOutcome } from "./domain.js";
import { ClockInSniperEngine } from "./engine.js";
import { discoverClockInLaunch, type DiscoveryEvent } from "./factory-discovery.js";
import { loadFactoryLiveRuntimeConfig } from "./factory-live-config.js";
import {
  runDiscoveredLaunchPreflight,
  runFactoryReadinessPreflight,
} from "./factory-live-preflight.js";
import { formatUsdMicros } from "./fee-schedule.js";
import { assertLiveLaunchUnused, FileLiveLedger, type LiveLedgerEvent } from "./live-ledger.js";
import { readErc20Balance } from "./live-preflight.js";
import { LiveTrancheSubmitter } from "./live-submitter.js";
import {
  LivePreparedTransactionSource,
  type PreparedTrancheMetadata,
} from "./live-transaction-source.js";
import { OfficialCaMonitor } from "./official-ca-monitor.js";
import { JsonRpcPoolObserver } from "./pool-observer.js";
import { ReceiptReconciler } from "./receipt-reconciler.js";
import { HttpJsonRpcClient } from "./rpc/http-json-rpc.js";
import { verifyRobinhoodMainnet, verifyRobinhoodSequencerWriteEndpoint } from "./rpc/robinhood.js";
import { WebSocketNewHeadsClient } from "./rpc/websocket-new-heads.js";
import type { Hex } from "./rpc/types.js";
import { buildNativeBuyCallData, CURRENT_FEE_CALL_DATA } from "./stonk-launcher.js";
import { FeeTrancheScheduler } from "./tranche-scheduler.js";
import { FileWalletLease } from "./wallet-lease.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeEvent(event: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const config = loadFactoryLiveRuntimeConfig(process.env);
const signerAddress = getAddress(new Wallet(config.privateKey).address) as Hex;
if (signerAddress !== getAddress(config.expectedWalletAddress)) {
  throw new Error("configured private key does not match expected live wallet");
}

const lease = await FileWalletLease.acquire(config.walletLeasePath, {
  walletAddress: signerAddress,
  launchId: config.launchId,
});
const shutdown = new AbortController();
let activeSubscription: { close(): void } | null = null;
let officialCaMonitor: OfficialCaMonitor | null = null;
let shuttingDown = false;
const stop = (): void => {
  shuttingDown = true;
  shutdown.abort();
  activeSubscription?.close();
  officialCaMonitor?.stop();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await assertLiveLaunchUnused(config.ledgerPath, config.launchId);
  const ledger = new FileLiveLedger(config.ledgerPath);
  const canonical = new HttpJsonRpcClient({
    providerId: config.providerId,
    url: config.rpcUrl,
    timeoutMs: 2_000,
  });
  const configuredBroadcastRequesters = config.broadcastRpcUrls.map(
    (url, index) =>
      new HttpJsonRpcClient({
        providerId: `clockin-broadcast-${index + 1}`,
        url,
        timeoutMs: 2_000,
      }),
  );
  const standardBroadcastRequesters = (
    await Promise.all(
      configuredBroadcastRequesters.map(async (requester) => {
        try {
          await verifyRobinhoodMainnet(requester);
          return requester;
        } catch (error) {
          await ledger.append({
            event: "broadcast_rpc_unavailable",
            launchId: config.launchId,
            providerId: requester.providerId,
            message: errorMessage(error),
          });
          writeEvent({
            event: "broadcast_rpc_unavailable",
            providerId: requester.providerId,
            message: errorMessage(error),
          });
          return null;
        }
      }),
    )
  ).filter((requester): requester is HttpJsonRpcClient => requester !== null);
  if (standardBroadcastRequesters.length === 0) {
    throw new Error("no standard Robinhood broadcast RPC passed chain verification");
  }
  let directSequencer =
    config.directSequencerUrl === undefined
      ? null
      : new HttpJsonRpcClient({
          providerId: "robinhood-direct-sequencer",
          url: config.directSequencerUrl,
          timeoutMs: 2_000,
        });
  if (directSequencer !== null) {
    try {
      await verifyRobinhoodSequencerWriteEndpoint(directSequencer);
    } catch (error) {
      await ledger.append({
        event: "direct_sequencer_unavailable",
        launchId: config.launchId,
        message: errorMessage(error),
      });
      writeEvent({ event: "direct_sequencer_unavailable", message: errorMessage(error) });
      directSequencer = null;
    }
  }
  const broadcastRequesters = Object.freeze([
    ...(directSequencer === null ? [] : [directSequencer]),
    ...standardBroadcastRequesters,
  ]);

  const readiness = await runFactoryReadinessPreflight(canonical, config);
  await ledger.append({
    event: "factory_live_armed",
    launchId: config.launchId,
    walletAddress: signerAddress,
    factoryAddress: config.identityPolicy.factoryAddress,
    factoryCodeHash: readiness.factoryCodeHash,
    armedAtBlock: readiness.identity.blockNumber.toString(),
    pendingNonce: readiness.pendingNonce.toString(),
    requiredWorstCaseWei: readiness.requiredWorstCaseWei.toString(),
    directSequencerArmed: directSequencer !== null,
  });
  writeEvent({
    event: "factory_live_armed",
    chainId: readiness.identity.chainId.toString(),
    blockNumber: readiness.identity.blockNumber.toString(),
    launchId: config.launchId,
    walletAddress: signerAddress,
    factoryAddress: config.identityPolicy.factoryAddress,
    directSequencerArmed: directSequencer !== null,
  });

  const onDiscoveryEvent = async (event: DiscoveryEvent): Promise<void> => {
    const serialized = {
      ...event,
      ...(event.kind === "armed" ? { startBlock: event.startBlock.toString() } : {}),
      ...(event.kind === "backfill"
        ? { fromBlock: event.fromBlock.toString(), toBlock: event.toBlock.toString() }
        : {}),
    };
    await ledger.append({
      event: `factory_${event.kind}`,
      launchId: config.launchId,
      ...serialized,
    });
    if (event.kind !== "backfill") writeEvent(serialized);
  };
  const candidate = await discoverClockInLaunch({
    requester: canonical,
    wsRpcUrl: config.wsRpcUrl,
    providerId: `${config.providerId}-factory-logs`,
    identityPolicy: config.identityPolicy,
    expectedFactoryCodeHash: config.expectedFactoryCodeHash,
    ...(config.discoveryStartBlock === undefined ? {} : { startBlock: config.discoveryStartBlock }),
    signal: shutdown.signal,
    onEvent: onDiscoveryEvent,
  });
  if (
    config.officialCaInitial !== undefined &&
    config.officialCaInitial.toLowerCase() !== candidate.tokenAddress.toLowerCase()
  ) {
    throw new Error("configured official CA contradicts the frozen Factory token");
  }

  const buyCallData = buildNativeBuyCallData(config.minTokensOut, config.refCode);
  const transactionOptions = Object.freeze({
    launchId: config.launchId,
    batchCount: config.batchCount,
    privateKey: config.privateKey,
    expectedWalletAddress: config.expectedWalletAddress,
    baseNonce: readiness.pendingNonce,
    buyTo: candidate.poolAddress,
    buyCallData,
    batchValueWei: config.batchValueWei,
    gasLimit: config.gasLimit,
    maxFeePerGasWei: config.maxFeePerGasWei,
    maxPriorityFeePerGasWei: config.maxPriorityFeePerGasWei,
  });
  const opportunityLedgerWrite = ledger.append({
    event: "opportunity_observed",
    launchId: config.launchId,
    source: candidate.source,
    launchTxHash: candidate.transactionHash,
    launchBlock: candidate.blockNumber.toString(),
    logIndex: candidate.logIndex.toString(),
    factoryAddress: candidate.factoryAddress,
    creator: candidate.creator,
    tokenAddress: candidate.tokenAddress,
    poolAddress: candidate.poolAddress,
    name: candidate.name,
    symbol: candidate.symbol,
    metadataUri: candidate.metadataUri,
  });
  const preflightPromise = runDiscoveredLaunchPreflight(
    canonical,
    config,
    candidate,
    readiness.pendingNonce,
  );
  // Local signing is speculative but not an authorization or a spend. It runs
  // in parallel with dynamic pool verification and is never broadcast unless
  // every preflight condition succeeds.
  const firstTransactionPromise = LivePreparedTransactionSource.prepareFirst(transactionOptions);
  writeEvent({
    event: "clockin_identity_frozen",
    source: candidate.source,
    launchTxHash: candidate.transactionHash,
    launchBlock: candidate.blockNumber.toString(),
    creator: candidate.creator,
    tokenAddress: candidate.tokenAddress,
    poolAddress: candidate.poolAddress,
    name: candidate.name,
    symbol: candidate.symbol,
  });
  const [, preflight, source] = await Promise.all([
    opportunityLedgerWrite,
    preflightPromise,
    firstTransactionPromise,
  ]);
  if (shuttingDown || shutdown.signal.aborted) {
    throw new Error("live execution stopped before first broadcast authorization");
  }
  const plan = Object.freeze({
    launchId: config.launchId,
    windowStartedAtMs: preflight.windowStartedAtMs,
    windowDurationMs: config.feeWindowDurationMs,
    startFeeBps: preflight.pool.currentFeeBps,
    floorFeeBps: config.expectedFloorFeeBps,
    batchCount: config.batchCount,
    grossUsdMicrosPerBatch: config.grossUsdMicrosPerBatch,
    minimumTrancheIntervalMs: preflight.pool.buyCooldownSecs * 1_000,
    chainAuthorizedTrancheCount: config.chainAuthorizedTrancheCount,
  });
  officialCaMonitor = new OfficialCaMonitor({
    expectedToken: candidate.tokenAddress,
    ...(config.officialCaInitial === undefined ? {} : { initialAddress: config.officialCaInitial }),
    filePath: config.officialCaFilePath,
    ...(config.officialCaUrl === undefined ? {} : { url: config.officialCaUrl }),
    jsonKey: config.officialCaJsonKey,
    pollMs: config.officialCaPollMs,
    onChange: async (snapshot) => {
      await ledger.append({
        event: "official_ca_state",
        launchId: config.launchId,
        state: snapshot.state,
        observedAddress: snapshot.observedAddress,
        source: snapshot.source,
      });
      writeEvent({
        event: "official_ca_state",
        state: snapshot.state,
        observedAddress: snapshot.observedAddress,
        source: snapshot.source,
      });
      if (snapshot.state === "mismatch") {
        shuttingDown = true;
        activeSubscription?.close();
      }
    },
  });

  const scheduler = new FeeTrancheScheduler(plan);
  const liveSessionEvent: LiveLedgerEvent = {
    event: "live_session_started",
    launchId: config.launchId,
    walletAddress: signerAddress,
    beneficiaryAddress: signerAddress,
    buyTo: candidate.poolAddress,
    tokenAddress: candidate.tokenAddress,
    poolAddress: candidate.poolAddress,
    launchTxHash: candidate.transactionHash,
    creator: candidate.creator,
    buySelector: buyCallData.slice(0, 10),
    buyCallDataHash: keccak256(buyCallData),
    feeCallDataHash: keccak256(CURRENT_FEE_CALL_DATA),
    tokenBalanceBefore: preflight.tokenBalanceBefore.toString(),
    batchCount: config.batchCount,
    batchValueWei: config.batchValueWei.toString(),
    windowStartedAtMs: plan.windowStartedAtMs,
    feeWindowEndsAtMs: plan.windowStartedAtMs + plan.windowDurationMs,
    executionExpiresAtMs: scheduler.snapshot().expiresAtMs,
    initialFeeBps: plan.startFeeBps,
    floorFeeBps: plan.floorFeeBps,
    buyCooldownSecs: preflight.pool.buyCooldownSecs,
    eoaOnlySecs: preflight.pool.eoaOnlySecs,
    windowMaxBuyBps: preflight.pool.windowMaxBuyBps,
    currentWindowCap: preflight.pool.currentWindowCap.toString(),
    chainAuthorizedTrancheCount: plan.chainAuthorizedTrancheCount,
  };

  function frozenPlanEvent(metadata: PreparedTrancheMetadata): LiveLedgerEvent {
    return {
      event: "plan_frozen",
      launchId: config.launchId,
      intentId: metadata.intentId,
      tranche: metadata.trancheNumber,
      nonce: metadata.nonce,
      txHash: metadata.txHash,
      valueWei: metadata.valueWei.toString(),
      gasLimit: metadata.gasLimit.toString(),
      maxFeePerGasWei: metadata.maxFeePerGasWei.toString(),
      maxPriorityFeePerGasWei: metadata.maxPriorityFeePerGasWei.toString(),
    };
  }
  async function persistFrozenPlan(metadata: PreparedTrancheMetadata): Promise<void> {
    await ledger.append(frozenPlanEvent(metadata));
  }
  const firstMetadata = source.allMetadata()[0];
  if (firstMetadata === undefined || firstMetadata.trancheNumber !== 1) {
    throw new Error("first live transaction was not prepared");
  }
  const firstPrepositionEvent: LiveLedgerEvent = {
    event: "first_tranche_preposition_authorized",
    launchId: config.launchId,
    intentId: firstMetadata.intentId,
    launchBlock: candidate.blockNumber.toString(),
    headAtPreflight: preflight.identity.blockNumber.toString(),
    earliestLegalInclusionBlock: (candidate.blockNumber + 1n).toString(),
    firstExternalHeadAlreadyObserved: preflight.identity.blockNumber > candidate.blockNumber,
    basis: "mined TokenLaunched log observed; pool same-block guard remains authoritative",
  };
  await ledger.appendMany([
    liveSessionEvent,
    frozenPlanEvent(firstMetadata),
    firstPrepositionEvent,
  ]);

  const observer = new JsonRpcPoolObserver(canonical, {
    poolAddress: candidate.poolAddress,
    feeCallData: CURRENT_FEE_CALL_DATA,
    externalBuyRule: { kind: "block_after", launchBlock: candidate.blockNumber },
  });
  const reconciler = new ReceiptReconciler({
    requester: canonical,
    ledger,
    tokenAddress: candidate.tokenAddress,
    beneficiaryAddress: signerAddress,
    pollMs: config.receiptPollMs,
    timeoutMs: config.receiptTimeoutMs,
  });
  const submitter = new LiveTrancheSubmitter({
    source,
    broadcastRequesters,
    ledger,
    reconciler,
    rebroadcastIntervalMs: config.receiptPollMs,
    buyCooldownMs: preflight.pool.buyCooldownSecs * 1_000,
  });
  const engine = new ClockInSniperEngine(scheduler, submitter);

  function writeDispatchOutcome(
    outcome: DispatchOutcome,
    officialCaConfirmed: boolean,
    extra: Readonly<Record<string, unknown>> = {},
  ): void {
    writeEvent({
      event: outcome.kind,
      tranche: outcome.intent.trancheNumber,
      txHash: outcome.kind === "submitted" ? outcome.submission.txHash : null,
      transportState: outcome.kind === "submitted" ? outcome.submission.state : null,
      blockNumber: outcome.intent.blockNumber.toString(),
      targetFeeBps: outcome.intent.targetFeeBps,
      observedFeeBps: outcome.intent.observedFeeBps,
      gross: formatUsdMicros(outcome.intent.grossUsdMicros),
      officialCaConfirmed,
      ...extra,
    });
  }

  // A mined TokenLaunched log means block N has already executed locally. Send
  // nonce N immediately so it can enter the next block; the pool's same-block
  // guard remains the canonical enforcement boundary for inclusion.
  if (shuttingDown || shutdown.signal.aborted) {
    throw new Error("live execution stopped before first broadcast");
  }
  const firstOutcome = await engine.observe({
    observedAtMs: Math.max(Date.now(), plan.windowStartedAtMs),
    blockNumber: candidate.blockNumber,
    feeBps: preflight.pool.currentFeeBps,
    externalBuyAllowed: true,
    officialCaConfirmed: false,
  });
  if (firstOutcome === null) {
    await ledger.append({
      event: "first_tranche_preposition_refused",
      launchId: config.launchId,
      launchBlock: candidate.blockNumber.toString(),
    });
    throw new Error("scheduler refused the first launch-block preposition");
  }
  writeDispatchOutcome(firstOutcome, false, {
    earliestLegalInclusionBlock: (candidate.blockNumber + 1n).toString(),
  });

  // Official announcement retrieval and the remaining signatures are warm-path
  // work for tranches 2-10; neither is allowed to delay the first 5U send.
  void officialCaMonitor.start().catch(async (error: unknown) => {
    await ledger.append({ event: "official_ca_monitor_error", message: errorMessage(error) });
  });
  try {
    await source.prepareRemaining();
    for (const metadata of source.allMetadata().slice(1)) {
      await persistFrozenPlan(metadata);
    }
  } catch (error) {
    shuttingDown = true;
    await ledger.append({
      event: "remaining_transaction_preparation_failed",
      launchId: config.launchId,
      message: errorMessage(error),
    });
    writeEvent({
      event: "remaining_transaction_preparation_failed",
      message: errorMessage(error),
    });
  }

  writeEvent({
    event: "clockin_live_ready",
    launchId: config.launchId,
    tokenAddress: candidate.tokenAddress,
    poolAddress: candidate.poolAddress,
    baseNonce: preflight.pendingNonce.toString(),
    initialFeeBps: preflight.pool.currentFeeBps,
    floorFeeBps: config.expectedFloorFeeBps,
    buyCooldownSecs: preflight.pool.buyCooldownSecs,
    executionExpiresAtMs: scheduler.snapshot().expiresAtMs,
    officialCaState: officialCaMonitor.snapshot().state,
    firstTrancheAttempt: firstOutcome.kind,
  });

  let lastObservedBlock = -1n;
  async function processObservation(
    observation: Awaited<ReturnType<typeof observer.observe>>,
  ): Promise<void> {
    if (observation.blockNumber <= lastObservedBlock) return;
    lastObservedBlock = observation.blockNumber;
    const caState = officialCaMonitor?.snapshot().state ?? "pending";
    if (caState === "mismatch") {
      shuttingDown = true;
      activeSubscription?.close();
      return;
    }
    const outcome = await engine.observe({
      ...observation,
      officialCaConfirmed: caState === "confirmed",
    });
    if (outcome !== null) {
      writeDispatchOutcome(outcome, caState === "confirmed");
    }
    if (scheduler.snapshot().status === "completed") activeSubscription?.close();
  }

  async function processWssBlock(blockNumber: bigint): Promise<void> {
    if (blockNumber <= lastObservedBlock) return;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await processObservation(await observer.observeAt(blockNumber));
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 25));
        }
      }
    }
    throw lastError;
  }

  function stillActive(): boolean {
    scheduler.expireAt(Date.now());
    return !shuttingDown && scheduler.snapshot().status === "active";
  }

  let reconnectAttempt = 0;
  while (stillActive()) {
    let queue = Promise.resolve();
    try {
      const heads = new WebSocketNewHeadsClient({
        providerId: `${config.providerId}-newHeads`,
        url: config.wsRpcUrl,
      });
      const subscription = await heads.subscribe((head) => {
        queue = queue
          .then(() => processWssBlock(head.blockNumber))
          .catch(async (error: unknown) => {
            await ledger.append({ event: "observation_error", message: errorMessage(error) });
            writeEvent({ event: "observation_error", message: errorMessage(error) });
          });
      });
      activeSubscription = subscription;
      reconnectAttempt = 0;
      queue = queue.then(async () => processObservation(await observer.observe()));
      const remainingMs = Math.max(1, scheduler.snapshot().expiresAtMs - Date.now() + 1);
      const expiryTimer = setTimeout(() => subscription.close(), remainingMs);
      try {
        await subscription.done;
      } finally {
        clearTimeout(expiryTimer);
        await queue;
      }
    } catch (error) {
      reconnectAttempt += 1;
      await ledger.append({
        event: "wss_reconnect",
        attempt: reconnectAttempt,
        message: errorMessage(error),
      });
      try {
        await processObservation(await observer.observe());
      } catch (pollError) {
        await ledger.append({ event: "http_bridge_error", message: errorMessage(pollError) });
      }
    } finally {
      activeSubscription = null;
    }
    if (!stillActive()) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1_000, 50 * 2 ** Math.min(reconnectAttempt, 4))),
    );
  }

  scheduler.expireAt(Date.now());
  const receipts = await submitter.waitForReconciliation();
  const tokenBalanceAfter = await readErc20Balance(
    canonical,
    candidate.tokenAddress,
    signerAddress,
  );
  const finalSnapshot = scheduler.snapshot();
  const successful = receipts.filter((receipt) => receipt.state === "success").length;
  const successNoTokens = receipts.filter(
    (receipt) => receipt.state === "success_no_tokens",
  ).length;
  const reverted = receipts.filter((receipt) => receipt.state === "reverted").length;
  const unknown = receipts.filter((receipt) => receipt.state === "unknown").length;
  const tokenBalanceDelta = tokenBalanceAfter - preflight.tokenBalanceBefore;
  await ledger.append({
    event: "position_observed",
    launchId: config.launchId,
    tokenAddress: candidate.tokenAddress,
    beneficiaryAddress: signerAddress,
    currentTokenBalanceRaw: tokenBalanceAfter.toString(),
    tokenBalanceDeltaRaw: tokenBalanceDelta.toString(),
    residualExposure: tokenBalanceAfter > 0n ? "nonzero" : "zero",
    automatedExit: "unsupported",
  });
  await ledger.append({
    event: "live_session_finished",
    launchId: config.launchId,
    schedulerStatus: finalSnapshot.status,
    submittedBatchCount: finalSnapshot.submittedBatchCount,
    successfulReceipts: successful,
    successfulWithoutTokens: successNoTokens,
    revertedReceipts: reverted,
    unknownReceipts: unknown,
    tokenBalanceBefore: preflight.tokenBalanceBefore.toString(),
    tokenBalanceAfter: tokenBalanceAfter.toString(),
    tokenBalanceDelta: tokenBalanceDelta.toString(),
    officialCaState: officialCaMonitor.snapshot().state,
  });
  writeEvent({
    event: "live_finished",
    status: finalSnapshot.status,
    submittedBatchCount: finalSnapshot.submittedBatchCount,
    successfulReceipts: successful,
    successfulWithoutTokens: successNoTokens,
    revertedReceipts: reverted,
    unknownReceipts: unknown,
    tokenBalanceDeltaRaw: tokenBalanceDelta.toString(),
    officialCaState: officialCaMonitor.snapshot().state,
  });
  if (
    finalSnapshot.status !== "completed" ||
    successful !== config.batchCount ||
    successNoTokens > 0 ||
    reverted > 0 ||
    unknown > 0 ||
    tokenBalanceDelta <= 0n
  ) {
    process.exitCode = 2;
  }
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  officialCaMonitor?.stop();
  await lease.release();
}
