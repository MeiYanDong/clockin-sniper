import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Interface } from "ethers";

import {
  assertLiveLaunchUnused,
  FileLiveLedger,
  FileWalletLease,
  InMemoryLiveLedger,
  loadLiveRecoverySnapshot,
  ReceiptReconciler,
  type Hex,
  type JsonRpcRequester,
  type PreparedTrancheMetadata,
} from "../src/index.js";

const TOKEN = `0x${"44".repeat(20)}` as Hex;
const BENEFICIARY = `0x${"55".repeat(20)}` as Hex;
const TX_HASH = `0x${"66".repeat(32)}` as Hex;
const metadata: PreparedTrancheMetadata = Object.freeze({
  intentId: "launch-1:tranche:1",
  trancheNumber: 1,
  nonce: 7,
  txHash: TX_HASH,
  valueWei: 1n,
  gasLimit: 21_000n,
  maxFeePerGasWei: 10n,
  maxPriorityFeePerGasWei: 1n,
});

function receiptRequester(withTokens: boolean): JsonRpcRequester {
  const erc20 = new Interface([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]);
  const transfer = erc20.encodeEventLog("Transfer", [`0x${"00".repeat(20)}`, BENEFICIARY, 123n]);
  return {
    providerId: "receipt-rpc",
    async request<T>(method: string): Promise<T> {
      assert.equal(method, "eth_getTransactionReceipt");
      return {
        transactionHash: TX_HASH,
        status: "0x1",
        blockNumber: "0x64",
        gasUsed: "0x5208",
        effectiveGasPrice: "0x3b9aca00",
        logs: withTokens ? [{ address: TOKEN, topics: transfer.topics, data: transfer.data }] : [],
      } as T;
    },
  };
}

test("reconciles a mined buy only when the bound token reached the beneficiary", async () => {
  const ledger = new InMemoryLiveLedger();
  const reconciler = new ReceiptReconciler({
    requester: receiptRequester(true),
    ledger,
    tokenAddress: TOKEN,
    beneficiaryAddress: BENEFICIARY,
    pollMs: 1,
    timeoutMs: 10,
  });

  const outcome = await reconciler.reconcile(metadata);
  assert.equal(outcome.state, "success");
  assert.equal(outcome.blockNumber, 100n);
  assert.equal(outcome.gasCostWei, 21_000_000_000_000n);
  assert.equal(outcome.tokensReceivedRaw, 123n);
  assert.equal(ledger.events[0]?.event, "receipt_observed");
});

test("flags a successful EVM receipt with no token delivery", async () => {
  const reconciler = new ReceiptReconciler({
    requester: receiptRequester(false),
    ledger: new InMemoryLiveLedger(),
    tokenAddress: TOKEN,
    beneficiaryAddress: BENEFICIARY,
    pollMs: 1,
    timeoutMs: 10,
  });

  assert.equal((await reconciler.reconcile(metadata)).state, "success_no_tokens");
});

test("ledger is owner-only and prevents replaying one launch id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clockin-live-ledger-"));
  const path = join(directory, "ledger.ndjson");
  try {
    await assertLiveLaunchUnused(path, "launch-1");
    const ledger = new FileLiveLedger(path, () => new Date("2026-08-15T00:00:00.000Z"));
    await ledger.append({ event: "live_session_started", launchId: "launch-1" });
    await assert.rejects(assertLiveLaunchUnused(path, "launch-1"), /already exists/);
    await assertLiveLaunchUnused(path, "launch-2");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.match(await readFile(path, "utf8"), /2026-08-15T00:00:00.000Z/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("wallet lease enforces one local writer and can be released", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clockin-wallet-lease-"));
  const path = join(directory, "wallet.lock");
  try {
    const first = await FileWalletLease.acquire(path, {
      walletAddress: BENEFICIARY,
      launchId: "launch-1",
    });
    await assert.rejects(
      FileWalletLease.acquire(path, { walletAddress: BENEFICIARY, launchId: "launch-1" }),
      /already exists/,
    );
    await first.release();
    const second = await FileWalletLease.acquire(path, {
      walletAddress: BENEFICIARY,
      launchId: "launch-2",
    });
    await second.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rebuilds crash-recovery inputs only from transactions that reached broadcast attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clockin-live-recovery-"));
  const path = join(directory, "ledger.ndjson");
  try {
    const ledger = new FileLiveLedger(path);
    await ledger.append({
      event: "live_session_started",
      launchId: "launch-1",
      walletAddress: BENEFICIARY,
      beneficiaryAddress: BENEFICIARY,
      tokenAddress: TOKEN,
      tokenBalanceBefore: "10",
    });
    for (const tranche of [1, 2]) {
      await ledger.append({
        event: "plan_frozen",
        launchId: "launch-1",
        intentId: `launch-1:tranche:${tranche}`,
        tranche,
        nonce: 6 + tranche,
        txHash: tranche === 1 ? TX_HASH : `0x${"77".repeat(32)}`,
        valueWei: "1",
        gasLimit: "21000",
        maxFeePerGasWei: "10",
        maxPriorityFeePerGasWei: "1",
      });
    }
    await ledger.append({
      event: "broadcast_attempted",
      launchId: "launch-1",
      intentId: "launch-1:tranche:1",
      txHash: TX_HASH,
    });

    const snapshot = await loadLiveRecoverySnapshot(path, "launch-1");
    assert.equal(snapshot.tokenBalanceBefore, 10n);
    assert.equal(snapshot.attemptedTransactions.length, 1);
    assert.equal(snapshot.attemptedTransactions[0]?.trancheNumber, 1);
    assert.equal(snapshot.attemptedTransactions[0]?.txHash, TX_HASH);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
