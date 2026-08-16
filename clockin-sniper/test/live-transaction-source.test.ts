import assert from "node:assert/strict";
import test from "node:test";

import { Transaction, Wallet } from "ethers";

import { LivePreparedTransactionSource, type Hex, type TrancheIntent } from "../src/index.js";

const PRIVATE_KEY = `0x${"11".repeat(32)}` as Hex;
const SIGNER = new Wallet(PRIVATE_KEY).address as Hex;
const BUY_TO = `0x${"33".repeat(20)}` as Hex;

function intent(trancheNumber: number): TrancheIntent {
  return Object.freeze({
    intentId: `launch-1:tranche:${trancheNumber}`,
    launchId: "launch-1",
    trancheNumber,
    attemptNumber: 1,
    targetFeeBps: 4_000,
    observedFeeBps: 4_000,
    referenceOffsetMs: 0,
    earliestDispatchOffsetMs: 0,
    grossUsdMicros: 5_000_000n,
    observedAtMs: 1,
    blockNumber: 1n,
    expiresAtMs: 2,
  });
}

test("pre-signs ten deterministic EIP-1559 transactions with sequential nonces", async () => {
  const source = await LivePreparedTransactionSource.prepare({
    launchId: "launch-1",
    batchCount: 10,
    privateKey: PRIVATE_KEY,
    expectedWalletAddress: SIGNER,
    baseNonce: 7n,
    buyTo: BUY_TO,
    buyCallData: "0xabcdef12",
    batchValueWei: 1_000_000_000_000_000n,
    gasLimit: 200_000n,
    maxFeePerGasWei: 10_000_000_000n,
    maxPriorityFeePerGasWei: 1_000_000_000n,
  });

  const metadata = source.allMetadata();
  assert.equal(metadata.length, 10);
  assert.equal(new Set(metadata.map((entry) => entry.txHash)).size, 10);

  for (let index = 0; index < 10; index += 1) {
    const trancheNumber = index + 1;
    const prepared = await source.get(intent(trancheNumber));
    const transaction = Transaction.from(prepared.rawTransaction);
    assert.equal(transaction.hash, prepared.expectedTxHash);
    assert.equal(transaction.from, SIGNER);
    assert.equal(transaction.chainId, 4_663n);
    assert.equal(transaction.type, 2);
    assert.equal(transaction.nonce, 7 + index);
    assert.equal(transaction.to, BUY_TO);
    assert.equal(transaction.data, "0xabcdef12");
    assert.equal(transaction.value, 1_000_000_000_000_000n);
    assert.equal(metadata[index]?.nonce, 7 + index);
  }
});

test("can sign tranche one on the hot path before preparing the remaining nonces", async () => {
  const source = await LivePreparedTransactionSource.prepareFirst({
    launchId: "launch-1",
    batchCount: 10,
    privateKey: PRIVATE_KEY,
    expectedWalletAddress: SIGNER,
    baseNonce: 17n,
    buyTo: BUY_TO,
    buyCallData: "0xabcdef12",
    batchValueWei: 1_000_000_000_000_000n,
    gasLimit: 200_000n,
    maxFeePerGasWei: 10_000_000_000n,
    maxPriorityFeePerGasWei: 1_000_000_000n,
  });

  assert.deepEqual(
    source.allMetadata().map((entry) => entry.trancheNumber),
    [1],
  );
  assert.equal(Transaction.from((await source.get(intent(1))).rawTransaction).nonce, 17);

  await source.prepareRemaining();
  assert.deepEqual(
    source.allMetadata().map((entry) => entry.nonce),
    [17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
  );
});

test("refuses a private key that does not match the bound live wallet", async () => {
  await assert.rejects(
    LivePreparedTransactionSource.prepare({
      launchId: "launch-1",
      batchCount: 10,
      privateKey: PRIVATE_KEY,
      expectedWalletAddress: `0x${"55".repeat(20)}`,
      baseNonce: 0n,
      buyTo: BUY_TO,
      buyCallData: "0xabcdef12",
      batchValueWei: 1n,
      gasLimit: 21_000n,
      maxFeePerGasWei: 2n,
      maxPriorityFeePerGasWei: 1n,
    }),
    /does not match/,
  );
});
