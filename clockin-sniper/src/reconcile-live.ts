import { FileLiveLedger, loadLiveRecoverySnapshot } from "./live-ledger.js";
import { readErc20Balance } from "./live-preflight.js";
import { ReceiptReconciler } from "./receipt-reconciler.js";
import { HttpJsonRpcClient } from "./rpc/http-json-rpc.js";
import { verifyRobinhoodMainnet } from "./rpc/robinhood.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  const value = raw === undefined || raw.length === 0 ? defaultValue : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

const launchId = required("CLOCKIN_LAUNCH_ID");
const ledgerPath = process.env.CLOCKIN_LEDGER_PATH?.trim() || "runtime/clockin-live.ndjson";
const receiptPollMs = positiveInteger("CLOCKIN_RECEIPT_POLL_MS", 250);
const receiptTimeoutMs = positiveInteger("CLOCKIN_RECEIPT_TIMEOUT_MS", 120_000);
const snapshot = await loadLiveRecoverySnapshot(ledgerPath, launchId);
const client = new HttpJsonRpcClient({
  providerId: process.env.ROBINHOOD_RPC_PROVIDER_ID?.trim() || "clockin-reconcile",
  url: required("ROBINHOOD_RPC_URL"),
  timeoutMs: Math.max(1_000, receiptPollMs * 4),
});
await verifyRobinhoodMainnet(client);

const ledger = new FileLiveLedger(ledgerPath);
await ledger.append({
  event: "recovery_started",
  launchId,
  attemptedTransactionCount: snapshot.attemptedTransactions.length,
});
const reconciler = new ReceiptReconciler({
  requester: client,
  ledger,
  tokenAddress: snapshot.tokenAddress,
  beneficiaryAddress: snapshot.beneficiaryAddress,
  pollMs: receiptPollMs,
  timeoutMs: receiptTimeoutMs,
});
const outcomes = await Promise.all(
  snapshot.attemptedTransactions.map((metadata) => reconciler.reconcile(metadata)),
);
const tokenBalanceAfter = await readErc20Balance(
  client,
  snapshot.tokenAddress,
  snapshot.beneficiaryAddress,
);
const successful = outcomes.filter((outcome) => outcome.state === "success").length;
const failed = outcomes.length - successful;
const tokenBalanceDelta = tokenBalanceAfter - snapshot.tokenBalanceBefore;
const complete = outcomes.length === 10 && successful === 10 && tokenBalanceDelta > 0n;
await ledger.append({
  event: "position_observed",
  launchId,
  tokenAddress: snapshot.tokenAddress,
  beneficiaryAddress: snapshot.beneficiaryAddress,
  currentTokenBalanceRaw: tokenBalanceAfter.toString(),
  tokenBalanceDeltaRaw: tokenBalanceDelta.toString(),
  residualExposure: tokenBalanceAfter > 0n ? "nonzero" : "zero",
  automatedExit: "unsupported",
  source: "recovery",
});
await ledger.append({
  event: "recovery_finished",
  launchId,
  attemptedTransactionCount: outcomes.length,
  successfulReceipts: successful,
  failedOrUnknownReceipts: failed,
  tokenBalanceBefore: snapshot.tokenBalanceBefore.toString(),
  tokenBalanceAfter: tokenBalanceAfter.toString(),
  tokenBalanceDelta: tokenBalanceDelta.toString(),
  complete,
});
process.stdout.write(
  `${JSON.stringify({
    event: "live_reconciliation_finished",
    launchId,
    attemptedTransactionCount: outcomes.length,
    successfulReceipts: successful,
    failedOrUnknownReceipts: failed,
    tokenBalanceDeltaRaw: tokenBalanceDelta.toString(),
    complete,
  })}\n`,
);
if (!complete) process.exitCode = 2;
