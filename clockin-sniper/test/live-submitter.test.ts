import assert from "node:assert/strict";
import { setImmediate as waitImmediate } from "node:timers/promises";
import test from "node:test";

import { Interface, Wallet, keccak256 } from "ethers";

import {
  InMemoryLiveLedger,
  JsonRpcRequestError,
  LivePreparedTransactionSource,
  LiveTrancheSubmitter,
  ReceiptReconciler,
  type Hex,
  type JsonRpcRequester,
  type TrancheIntent,
} from "../src/index.js";

const PRIVATE_KEY = `0x${"11".repeat(32)}` as Hex;
const SIGNER = new Wallet(PRIVATE_KEY).address as Hex;
const BUY_TO = `0x${"33".repeat(20)}` as Hex;
const TOKEN = `0x${"44".repeat(20)}` as Hex;

test("an unknown send rebroadcasts the exact same signed bytes while receipt polling continues", async () => {
  const source = await LivePreparedTransactionSource.prepare({
    launchId: "launch-1",
    batchCount: 1,
    privateKey: PRIVATE_KEY,
    expectedWalletAddress: SIGNER,
    baseNonce: 7n,
    buyTo: BUY_TO,
    buyCallData: "0xabcdef12",
    batchValueWei: 1n,
    gasLimit: 21_000n,
    maxFeePerGasWei: 10n,
    maxPriorityFeePerGasWei: 1n,
  });
  const expectedHash = source.allMetadata()[0]?.txHash;
  assert.ok(expectedHash);

  const sentRaw: string[] = [];
  const broadcaster: JsonRpcRequester = {
    providerId: "broadcast-rpc",
    async request<T>(_method: string, params: readonly unknown[] = []): Promise<T> {
      sentRaw.push(String(params[0]));
      if (sentRaw.length === 1) {
        throw new JsonRpcRequestError({
          providerId: "broadcast-rpc",
          method: "eth_sendRawTransaction",
          message: "timeout after 2000ms",
        });
      }
      return expectedHash as T;
    },
  };

  let resolveReceipt!: (value: unknown) => void;
  const pendingReceipt = new Promise<unknown>((resolve) => {
    resolveReceipt = resolve;
  });
  const receiptRequester: JsonRpcRequester = {
    providerId: "receipt-rpc",
    async request<T>(): Promise<T> {
      return pendingReceipt as Promise<T>;
    },
  };
  const ledger = new InMemoryLiveLedger();
  const reconciler = new ReceiptReconciler({
    requester: receiptRequester,
    ledger,
    tokenAddress: TOKEN,
    beneficiaryAddress: SIGNER,
    pollMs: 1,
    timeoutMs: 1_000,
  });
  const submitter = new LiveTrancheSubmitter({
    source,
    broadcastRequesters: [broadcaster],
    ledger,
    reconciler,
    rebroadcastIntervalMs: 1,
    now: () => 0,
    sleep: async () => undefined,
  });
  const intent: TrancheIntent = Object.freeze({
    intentId: "launch-1:tranche:1",
    launchId: "launch-1",
    trancheNumber: 1,
    attemptNumber: 1,
    targetFeeBps: 4_000,
    observedFeeBps: 4_000,
    referenceOffsetMs: 0,
    earliestDispatchOffsetMs: 0,
    grossUsdMicros: 5_000_000n,
    observedAtMs: 0,
    blockNumber: 1n,
    expiresAtMs: 10,
  });

  assert.equal((await submitter.submit(intent)).state, "unknown");
  for (let index = 0; index < 10 && sentRaw.length < 2; index += 1) await waitImmediate();
  assert.equal(sentRaw.length, 2);
  assert.equal(sentRaw[0], sentRaw[1]);

  const erc20 = new Interface([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]);
  const transfer = erc20.encodeEventLog("Transfer", [`0x${"00".repeat(20)}`, SIGNER, 1n]);
  resolveReceipt({
    transactionHash: expectedHash,
    status: "0x1",
    blockNumber: "0x1",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    logs: [{ address: TOKEN, topics: transfer.topics, data: transfer.data }],
  });

  assert.equal((await submitter.waitForReconciliation())[0]?.state, "success");
  assert.ok(ledger.events.some((event) => event.event === "exact_raw_rebroadcast"));
});

test("does not advance the signer nonce lane until the previous tranche has canonical token delivery", async () => {
  const source = await LivePreparedTransactionSource.prepare({
    launchId: "launch-2",
    batchCount: 2,
    privateKey: PRIVATE_KEY,
    expectedWalletAddress: SIGNER,
    baseNonce: 9n,
    buyTo: BUY_TO,
    buyCallData: "0xabcdef12",
    batchValueWei: 1n,
    gasLimit: 21_000n,
    maxFeePerGasWei: 10n,
    maxPriorityFeePerGasWei: 1n,
  });
  const broadcaster: JsonRpcRequester = {
    providerId: "broadcast-rpc",
    async request<T>(_method: string, params: readonly unknown[] = []): Promise<T> {
      return keccak256(String(params[0])) as T;
    },
  };
  const erc20 = new Interface([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]);
  const transfer = erc20.encodeEventLog("Transfer", [`0x${"00".repeat(20)}`, SIGNER, 1n]);
  let releaseFirst!: (receipt: unknown) => void;
  const firstReceipt = new Promise<unknown>((resolve) => {
    releaseFirst = resolve;
  });
  const [firstMetadata, secondMetadata] = source.allMetadata();
  assert.ok(firstMetadata);
  assert.ok(secondMetadata);
  const receipt = (txHash: string) => ({
    transactionHash: txHash,
    status: "0x1",
    blockNumber: "0x1",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    logs: [{ address: TOKEN, topics: transfer.topics, data: transfer.data }],
  });
  const receiptRequester: JsonRpcRequester = {
    providerId: "receipt-rpc",
    async request<T>(_method: string, params: readonly unknown[] = []): Promise<T> {
      return (
        String(params[0]).toLowerCase() === firstMetadata.txHash.toLowerCase()
          ? firstReceipt
          : receipt(secondMetadata.txHash)
      ) as Promise<T>;
    },
  };
  const ledger = new InMemoryLiveLedger();
  let nowMs = 0;
  const submitter = new LiveTrancheSubmitter({
    source,
    broadcastRequesters: [broadcaster],
    ledger,
    reconciler: new ReceiptReconciler({
      requester: receiptRequester,
      ledger,
      tokenAddress: TOKEN,
      beneficiaryAddress: SIGNER,
      pollMs: 1,
      timeoutMs: 1_000,
    }),
    buyCooldownMs: 1_000,
    now: () => nowMs,
  });
  const intent = (trancheNumber: number): TrancheIntent => ({
    intentId: `launch-2:tranche:${trancheNumber}`,
    launchId: "launch-2",
    trancheNumber,
    attemptNumber: 1,
    targetFeeBps: trancheNumber === 1 ? 4_000 : 3_500,
    observedFeeBps: trancheNumber === 1 ? 4_000 : 3_500,
    referenceOffsetMs: 0,
    earliestDispatchOffsetMs: 0,
    grossUsdMicros: 5_000_000n,
    observedAtMs: 0,
    blockNumber: BigInt(trancheNumber),
    expiresAtMs: 10_000,
  });

  await submitter.submit(intent(1));
  await assert.rejects(submitter.submit(intent(2)), /previous tranche/);
  releaseFirst(receipt(firstMetadata.txHash));
  for (
    let index = 0;
    index < 10 && !ledger.events.some((event) => event.event === "receipt_observed");
    index += 1
  ) {
    await waitImmediate();
  }
  await assert.rejects(submitter.submit(intent(2)), /cooldown/);
  nowMs = 1_000;
  assert.equal((await submitter.submit(intent(2))).state, "accepted");
  assert.deepEqual(
    (await submitter.waitForReconciliation()).map((outcome) => outcome.state),
    ["success", "success"],
  );
  assert.ok(ledger.events.some((event) => event.event === "tranche_gate_blocked"));
  assert.ok(ledger.events.some((event) => event.event === "tranche_cooldown_blocked"));
});
