import { Wallet, getAddress, keccak256 } from "ethers";

import { ClockInSniperEngine } from "./engine.js";
import { formatUsdMicros } from "./fee-schedule.js";
import { loadLiveRuntimeConfig } from "./live-config.js";
import { assertLiveLaunchUnused, FileLiveLedger } from "./live-ledger.js";
import { readErc20Balance, runLivePreflight } from "./live-preflight.js";
import { LiveTrancheSubmitter } from "./live-submitter.js";
import { LivePreparedTransactionSource } from "./live-transaction-source.js";
import { JsonRpcPoolObserver } from "./pool-observer.js";
import { ReceiptReconciler } from "./receipt-reconciler.js";
import { HttpJsonRpcClient } from "./rpc/http-json-rpc.js";
import { verifyRobinhoodMainnet } from "./rpc/robinhood.js";
import { WebSocketNewHeadsClient } from "./rpc/websocket-new-heads.js";
import { FeeTrancheScheduler } from "./tranche-scheduler.js";
import { FileWalletLease } from "./wallet-lease.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeEvent(event: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const config = loadLiveRuntimeConfig(process.env);
const signerAddress = getAddress(new Wallet(config.privateKey).address);
if (signerAddress !== getAddress(config.expectedWalletAddress)) {
  throw new Error("configured private key does not match expected live wallet");
}

const lease = await FileWalletLease.acquire(config.walletLeasePath, {
  walletAddress: signerAddress,
  launchId: config.plan.launchId,
});
let activeSubscription: { close(): void } | null = null;
let shuttingDown = false;
const stop = (): void => {
  shuttingDown = true;
  activeSubscription?.close();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await assertLiveLaunchUnused(config.ledgerPath, config.plan.launchId);
  const ledger = new FileLiveLedger(config.ledgerPath);
  const canonical = new HttpJsonRpcClient({
    providerId: config.providerId,
    url: config.rpcUrl,
    timeoutMs: Math.max(1_000, config.pollIntervalMs * 4),
  });
  const broadcastRequesters = config.broadcastRpcUrls.map(
    (url, index) =>
      new HttpJsonRpcClient({
        providerId: `clockin-broadcast-${index + 1}`,
        url,
        timeoutMs: 2_000,
      }),
  );
  await Promise.all(broadcastRequesters.map((requester) => verifyRobinhoodMainnet(requester)));

  const preflight = await runLivePreflight(canonical, config);
  const source = await LivePreparedTransactionSource.prepare({
    launchId: config.plan.launchId,
    batchCount: config.plan.batchCount,
    privateKey: config.privateKey,
    expectedWalletAddress: config.expectedWalletAddress,
    baseNonce: preflight.pendingNonce,
    buyTo: config.buyTo,
    buyCallData: config.buyCallData,
    batchValueWei: config.batchValueWei,
    gasLimit: config.gasLimit,
    maxFeePerGasWei: config.maxFeePerGasWei,
    maxPriorityFeePerGasWei: config.maxPriorityFeePerGasWei,
  });
  await ledger.append({
    event: "live_session_started",
    launchId: config.plan.launchId,
    walletAddress: signerAddress,
    beneficiaryAddress: config.beneficiaryAddress,
    buyTo: config.buyTo,
    tokenAddress: config.tokenAddress,
    poolAddress: config.pool.poolAddress,
    buySelector: config.buyCallData.slice(0, 10),
    buyCallDataHash: keccak256(config.buyCallData),
    feeCallDataHash: keccak256(config.pool.feeCallData),
    tokenBalanceBefore: preflight.tokenBalanceBefore.toString(),
    batchCount: config.plan.batchCount,
    batchValueWei: config.batchValueWei.toString(),
    windowStartedAtMs: config.plan.windowStartedAtMs,
    expiresAtMs: config.plan.windowStartedAtMs + config.plan.windowDurationMs,
  });
  for (const metadata of source.allMetadata()) {
    await ledger.append({
      event: "plan_frozen",
      launchId: config.plan.launchId,
      intentId: metadata.intentId,
      tranche: metadata.trancheNumber,
      nonce: metadata.nonce,
      txHash: metadata.txHash,
      valueWei: metadata.valueWei.toString(),
      gasLimit: metadata.gasLimit.toString(),
      maxFeePerGasWei: metadata.maxFeePerGasWei.toString(),
      maxPriorityFeePerGasWei: metadata.maxPriorityFeePerGasWei.toString(),
    });
  }

  const observer = new JsonRpcPoolObserver(canonical, config.pool);
  const scheduler = new FeeTrancheScheduler(config.plan);
  const reconciler = new ReceiptReconciler({
    requester: canonical,
    ledger,
    tokenAddress: config.tokenAddress,
    beneficiaryAddress: config.beneficiaryAddress,
    pollMs: config.receiptPollMs,
    timeoutMs: config.receiptTimeoutMs,
  });
  const submitter = new LiveTrancheSubmitter({
    source,
    broadcastRequesters,
    ledger,
    reconciler,
    rebroadcastIntervalMs: config.receiptPollMs,
  });
  const engine = new ClockInSniperEngine(scheduler, submitter);

  writeEvent({
    event: "live_armed",
    chainId: preflight.identity.chainId.toString(),
    blockNumber: preflight.identity.blockNumber.toString(),
    walletAddress: signerAddress,
    launchId: config.plan.launchId,
    pendingNonce: preflight.pendingNonce.toString(),
    batchCount: config.plan.batchCount,
    batchValueWei: config.batchValueWei.toString(),
    requiredWorstCaseWei: preflight.requiredWorstCaseWei.toString(),
    baseFeePerGasWei: preflight.baseFeePerGasWei.toString(),
    observedFeeBps: preflight.observedFeeBps,
    expiresAtMs: scheduler.snapshot().expiresAtMs,
  });

  let lastObservedBlock = -1n;
  async function processObservation(
    observation: Awaited<ReturnType<typeof observer.observe>>,
  ): Promise<void> {
    if (observation.blockNumber <= lastObservedBlock) return;
    lastObservedBlock = observation.blockNumber;
    const outcome = await engine.observe(observation);
    if (outcome !== null) {
      writeEvent({
        event: outcome.kind,
        tranche: outcome.intent.trancheNumber,
        txHash: outcome.kind === "submitted" ? outcome.submission.txHash : null,
        transportState: outcome.kind === "submitted" ? outcome.submission.state : null,
        blockNumber: outcome.intent.blockNumber.toString(),
        targetFeeBps: outcome.intent.targetFeeBps,
        observedFeeBps: outcome.intent.observedFeeBps,
        gross: formatUsdMicros(outcome.intent.grossUsdMicros),
      });
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
      writeEvent({ event: "wss_reconnect", attempt: reconnectAttempt });
      // WSS failure must not blind the live process; bridge once through canonical HTTP.
      try {
        await processObservation(await observer.observe());
      } catch (pollError) {
        await ledger.append({ event: "http_bridge_error", message: errorMessage(pollError) });
      }
    } finally {
      activeSubscription = null;
    }

    if (!stillActive()) break;
    const backoffMs = Math.min(1_000, 50 * 2 ** Math.min(reconnectAttempt, 4));
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }

  scheduler.expireAt(Date.now());
  const receipts = await submitter.waitForReconciliation();
  const tokenBalanceAfter = await readErc20Balance(
    canonical,
    config.tokenAddress,
    config.beneficiaryAddress,
  );
  const finalSnapshot = scheduler.snapshot();
  const successful = receipts.filter((receipt) => receipt.state === "success").length;
  const successNoTokens = receipts.filter(
    (receipt) => receipt.state === "success_no_tokens",
  ).length;
  const reverted = receipts.filter((receipt) => receipt.state === "reverted").length;
  const unknown = receipts.filter((receipt) => receipt.state === "unknown").length;
  await ledger.append({
    event: "live_session_finished",
    launchId: config.plan.launchId,
    schedulerStatus: finalSnapshot.status,
    submittedBatchCount: finalSnapshot.submittedBatchCount,
    successfulReceipts: successful,
    successfulWithoutTokens: successNoTokens,
    revertedReceipts: reverted,
    unknownReceipts: unknown,
    tokenBalanceBefore: preflight.tokenBalanceBefore.toString(),
    tokenBalanceAfter: tokenBalanceAfter.toString(),
    tokenBalanceDelta: (tokenBalanceAfter - preflight.tokenBalanceBefore).toString(),
  });
  writeEvent({
    event: "live_finished",
    status: finalSnapshot.status,
    submittedBatchCount: finalSnapshot.submittedBatchCount,
    successfulReceipts: successful,
    successfulWithoutTokens: successNoTokens,
    revertedReceipts: reverted,
    unknownReceipts: unknown,
    tokenBalanceDeltaRaw: (tokenBalanceAfter - preflight.tokenBalanceBefore).toString(),
  });
  if (
    finalSnapshot.status !== "completed" ||
    successful !== config.plan.batchCount ||
    successNoTokens > 0 ||
    reverted > 0 ||
    unknown > 0 ||
    tokenBalanceAfter <= preflight.tokenBalanceBefore
  ) {
    process.exitCode = 2;
  }
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await lease.release();
}
