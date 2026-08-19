import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { getBytes, keccak256 } from "ethers";

import type { SameRawBroadcastResult } from "../src/broadcast/same-raw-broadcaster.js";
import type { Address, Hex32 } from "../src/core/canonical.js";
import type { ProductionReceipt } from "../src/runtime/production-rpc.js";
import type { JsonRpcRequester } from "../src/rpc/types.js";
import type { StonkSafeLaunchWalletReadinessReport } from "../src/runtime/stonk-safe-launch-wallet-readiness.js";
import {
  assertNoUnresolvedPreparationRecords,
  assertPreparationAllInRiskWithinCap,
  assertCanonicalPreparationReceipt,
  assertPreparationCanBroadcast,
  assertProceedableBroadcast,
  bufferedWethPrincipal,
  completedPreparationGasWei,
  PreparationRecoveryJournal,
  planStonkSafeLaunchPreparationBatch,
  recoverPreparationRecords,
  signPreparationTransactionAfterLiveGuards,
  signedTxVaultReference,
  type CanonicalPreparationReceipt,
  type PreparationRecoveryProbeSnapshot,
  type PreparationRecoveryVault,
} from "../src/prepare-stonk-safe-launch-wallets.js";

const gas = Object.freeze({
  depositGasLimit: 80_000n,
  approvalGasLimit: 100_000n,
  entryGasLimit: 500_000n,
  maximumFeePerGasWei: 200_000_000n,
  gasSafetyMarginBps: 3_000,
});

function readiness(
  overrides: {
    readonly nativeBalanceWei?: bigint;
    readonly allowanceRaw?: bigint;
    readonly firstWalletWethRaw?: bigint;
  } = {},
): StonkSafeLaunchWalletReadinessReport {
  const rows = Array.from({ length: 10 }, (_, index) => {
    const suffix = (index + 1).toString(16).padStart(40, "0");
    return Object.freeze({
      walletId: `entry-${String(index + 1).padStart(2, "0")}`,
      address: `0x${suffix}` as `0x${string}`,
      latestNonce: 0n,
      pendingNonce: 0n,
      nativeBalanceWei: overrides.nativeBalanceWei ?? 3_200_000_000_000_000n,
      wethBalanceRaw: index === 0 ? (overrides.firstWalletWethRaw ?? 0n) : 0n,
      wethAllowanceRaw: overrides.allowanceRaw ?? 0n,
      requiredWethRaw: 1n,
      requiredNativeGasWei: 1n,
      eoaReady: true,
      nonceReady: true,
      gasReady: true,
      wethReady: false,
      allowanceReady: false,
      ready: false,
    });
  });
  return Object.freeze({
    chainId: 4_663n,
    blockNumber: 1n,
    rows: Object.freeze(rows),
    readyWallets: 0,
    aggregateWethRequiredRaw: 10n,
    canaryArmed: false,
    allLanesArmed: false,
  });
}

describe("one-shot Safe Launch WETH wallet preparation", () => {
  it("supports the production 10% principal buffer and rejects anything larger", () => {
    assert.equal(bufferedWethPrincipal(1_001n, 500), 1_052n);
    assert.equal(bufferedWethPrincipal(1_000n, 1_000), 1_100n);
    assert.throws(() => bufferedWethPrincipal(1_000n, 1_001), /0\.\.1000 bps/);
  });

  it("freezes all ten executable plans before broadcasting and approves only the exact pad amount", () => {
    const nominal = 2_395_525_159_002_982n;
    const batch = planStonkSafeLaunchPreparationBatch({
      readiness: readiness(),
      nominalBatchWethRaw: nominal,
      principalBufferBps: 500,
      gas,
    });
    const buffered = bufferedWethPrincipal(nominal, 500);
    assert.equal(batch.wallets.length, 10);
    assert.equal(batch.executable, true);
    assert.equal(batch.bufferedBatchWethRaw, buffered);
    for (const wallet of batch.wallets) {
      assert.deepEqual(
        wallet.actions.map((action) => action.kind),
        ["WRAP_WETH", "APPROVE_WETH"],
      );
      const approval = wallet.actions[1];
      assert.ok(approval);
      assert.match(approval.calldata, /^0x095ea7b3/u);
      assert.equal(BigInt(`0x${approval.calldata.slice(-64)}`), buffered);
      assert.ok(
        approval.calldata.toLowerCase().includes("abea69101b2a19347a34339f24cad8b9523e9c29"),
      );
    }
  });

  it("freezes ten-wallet buffered principal plus wrap/approve/entry maximum gas under 60U", () => {
    const batch = planStonkSafeLaunchPreparationBatch({
      readiness: readiness(),
      nominalBatchWethRaw: 2_500_000_000_000_000n,
      principalBufferBps: 1_000,
      gas,
    });
    const report = assertPreparationAllInRiskWithinCap({
      batch,
      usdMicrosPerEth: 2_000_000_000n,
      allInRiskCapUsdMicros: 60_000_000n,
    });
    assert.equal(report.bufferedPrincipalUsdMicros, 55_000_000n);
    assert.equal(report.completedPreparationGasWei, 0n);
    assert.ok(report.totalUsdMicros <= 60_000_000n);
    assert.throws(
      () =>
        assertPreparationAllInRiskWithinCap({
          batch,
          usdMicrosPerEth: 2_000_000_000n,
          allInRiskCapUsdMicros: 55_000_000n,
        }),
      /exceeds/u,
    );
  });

  it("replaces an oversized allowance with an exact finite allowance", () => {
    const nominal = 1_000n;
    const batch = planStonkSafeLaunchPreparationBatch({
      readiness: readiness({ allowanceRaw: (1n << 256n) - 1n }),
      nominalBatchWethRaw: nominal,
      principalBufferBps: 500,
      gas,
    });
    const approval = batch.wallets[0]?.actions.at(-1);
    assert.equal(approval?.kind, "APPROVE_WETH");
    assert.equal(BigInt(`0x${approval?.calldata.slice(-64)}`), 1_050n);
  });

  it("fails closed before the first transaction if one wallet cannot fund its full plan", () => {
    const batch = planStonkSafeLaunchPreparationBatch({
      readiness: readiness({ nativeBalanceWei: 1n }),
      nominalBatchWethRaw: 1_000n,
      principalBufferBps: 500,
      gas,
    });
    assert.equal(batch.executable, false);
    assert.throws(
      () =>
        assertPreparationCanBroadcast({
          batch,
          authorizationExpiresAt: "2030-01-01T00:00:00.000Z",
          nowMs: Date.parse("2029-01-01T00:00:00.000Z"),
        }),
      /all ten wallet plans/,
    );
  });

  it("stops immediately on UNKNOWN or rejected transport state", () => {
    const base = { txHash: `0x${"11".repeat(32)}` as const, outcomes: [] as const };
    assert.throws(() => assertProceedableBroadcast({ ...base, state: "UNKNOWN" }), /UNKNOWN/);
    assert.throws(() => assertProceedableBroadcast({ ...base, state: "REJECTED" }), /rejected/);
    assert.doesNotThrow(() => assertProceedableBroadcast({ ...base, state: "ACCEPTED" }));
  });

  it("binds either canonical receipt status and requires an advanced nonce", () => {
    const txHash = `0x${"11".repeat(32)}` as const;
    const blockHash = `0x${"22".repeat(32)}` as const;
    const receipt = Object.freeze({
      transactionHash: txHash,
      blockNumber: 2n,
      blockHash,
      transactionIndex: 0n,
      status: 1,
      gasUsed: 21_000n,
      effectiveGasPrice: 1n,
      logs: Object.freeze([]),
    }) satisfies ProductionReceipt;
    assert.doesNotThrow(() =>
      assertCanonicalPreparationReceipt({
        receipt,
        expectedTxHash: txHash,
        expectedBlockHash: blockHash,
        observedLatestNonce: 8n,
        submittedNonce: 7n,
      }),
    );
    assert.doesNotThrow(() =>
      assertCanonicalPreparationReceipt({
        receipt: { ...receipt, status: 0 },
        expectedTxHash: txHash,
        expectedBlockHash: blockHash,
        observedLatestNonce: 8n,
        submittedNonce: 7n,
      }),
    );
    assert.throws(() =>
      assertCanonicalPreparationReceipt({
        receipt,
        expectedTxHash: txHash,
        expectedBlockHash: blockHash,
        observedLatestNonce: 7n,
        submittedNonce: 7n,
      }),
    );
  });

  it("defers above the authorized live base fee before signing and rechecks prior receipts", async () => {
    let receiptReads = 0;
    let signs = 0;
    let markerChecks = 0;
    const feeBlockHash = `0x${"33".repeat(32)}` as Hex32;
    const requester: JsonRpcRequester = {
      providerId: "preparation-fee-test",
      request: async <T>(method: string, params: readonly unknown[] = []) => {
        let value: unknown;
        if (method === "eth_getTransactionReceipt") {
          receiptReads += 1;
          value = {
            transactionHash: TX_HASH,
            blockNumber: "0x7",
            blockHash: BLOCK_HASH,
            transactionIndex: "0x0",
            status: "0x1",
            gasUsed: "0x5208",
            effectiveGasPrice: "0x1",
            logs: [],
          };
        } else if (method === "eth_getTransactionCount") {
          value = "0x1";
        } else if (method === "eth_getBlockByNumber" && params[0] === "0x7") {
          value = { number: "0x7", hash: BLOCK_HASH, baseFeePerGas: "0x1" };
        } else if (method === "eth_getBlockByNumber" && params[0] === "latest") {
          value = { number: "0x8", hash: feeBlockHash, baseFeePerGas: "0xc8" };
        } else if (method === "eth_getBlockByNumber" && params[0] === "0x8") {
          value = { number: "0x8", hash: feeBlockHash, baseFeePerGas: "0xc8" };
        } else {
          throw new Error(`unexpected RPC ${method} ${String(params[0])}`);
        }
        return value as T;
      },
    };

    await assert.rejects(
      signPreparationTransactionAfterLiveGuards({
        requester,
        priorReceipts: [canonicalReceipt()],
        walletAddress: WALLET,
        expectedNonce: 1n,
        maximumFeePerGasWei: 200n,
        maximumPriorityFeePerGasWei: 1n,
        assertMarkers: async () => {
          markerChecks += 1;
        },
        signTransaction: async () => {
          signs += 1;
          return RAW;
        },
      }),
      /deferred.*base fee/u,
    );
    assert.equal(receiptReads, 1);
    assert.equal(markerChecks, 0);
    assert.equal(signs, 0);
  });
});

const RAW = "0x01020304" as const;
const TX_HASH = keccak256(getBytes(RAW)) as Hex32;
const WALLET = `0x${"11".repeat(20)}` as Address;
const BLOCK_HASH = `0x${"22".repeat(32)}` as Hex32;

function accepted(txHash: Hex32 = TX_HASH): SameRawBroadcastResult {
  return Object.freeze({ txHash, state: "ACCEPTED", outcomes: Object.freeze([]) });
}

function canonicalReceipt(nonce = 0n): CanonicalPreparationReceipt {
  return Object.freeze({
    txHash: TX_HASH,
    walletAddress: WALLET,
    nonce,
    action: "WRAP_WETH",
    blockNumber: 7n,
    blockHash: BLOCK_HASH,
    gasUsed: 21_000n,
    effectiveGasPrice: 1n,
    status: 1,
  });
}

function unknownProbe(nonce = 0n): PreparationRecoveryProbeSnapshot {
  return Object.freeze({
    receipt: null,
    transactionKnown: false,
    latestNonce: nonce,
    pendingNonce: nonce,
  });
}

class MemoryRecoveryVault implements PreparationRecoveryVault {
  readonly values = new Map<string, `0x${string}`>();

  async exists(reference: string): Promise<boolean> {
    return this.values.has(reference);
  }

  async get(reference: string, expectedTxHash: Hex32): Promise<`0x${string}`> {
    const raw = this.values.get(reference);
    if (raw === undefined) throw new Error("missing vault payload");
    assert.equal(keccak256(getBytes(raw)).toLowerCase(), expectedTxHash.toLowerCase());
    return raw;
  }

  async remove(reference: string): Promise<void> {
    this.values.delete(reference);
  }
}

async function recoveryFixture(): Promise<{
  readonly directory: string;
  readonly journal: PreparationRecoveryJournal;
  readonly vault: MemoryRecoveryVault;
  readonly vaultRef: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "clockin-weth-recovery-"));
  const journal = new PreparationRecoveryJournal(join(directory, "journal"));
  const vault = new MemoryRecoveryVault();
  const vaultRef = signedTxVaultReference(join(directory, "vault"), TX_HASH);
  return { directory, journal, vault, vaultRef };
}

async function createRecoveryRecord(
  journal: PreparationRecoveryJournal,
  vaultRef: string,
): Promise<void> {
  await journal.create({
    txHash: TX_HASH,
    walletAddress: WALLET,
    nonce: "0",
    action: "WRAP_WETH",
    vaultRef,
    createdAt: "2026-08-20T00:00:00.000Z",
  });
}

async function createTerminalRecoveryRecord(
  journal: PreparationRecoveryJournal,
  vaultRef: string,
  state: "FINAL" | "FINAL_REVERTED" = "FINAL",
): Promise<void> {
  await createRecoveryRecord(journal, vaultRef);
  const [created] = await journal.list();
  assert.ok(created);
  await journal.transition(created, state, "2026-08-20T00:00:01.000Z", {
    blockNumber: "7",
    blockHash: BLOCK_HASH,
    status: state === "FINAL" ? 1 : 0,
  });
}

describe("durable WETH preparation recovery", () => {
  it("revalidates FINAL history after restart and merges its actual gas with the remaining 19 steps", async () => {
    const fixture = await recoveryFixture();
    try {
      await createTerminalRecoveryRecord(fixture.journal, fixture.vaultRef);
      fixture.vault.values.set(fixture.vaultRef, RAW);
      const historical = await recoverPreparationRecords({
        journal: fixture.journal,
        vault: fixture.vault,
        probe: async () => unknownProbe(1n),
        waitForReceipt: async () => canonicalReceipt(),
        broadcaster: { broadcast: async () => accepted() },
        assertMarkers: async () => undefined,
        now: () => "2026-08-20T00:00:02.000Z",
      });
      const batch = planStonkSafeLaunchPreparationBatch({
        readiness: readiness({ firstWalletWethRaw: 1_100n }),
        nominalBatchWethRaw: 1_000n,
        principalBufferBps: 1_000,
        gas,
      });
      const remainingActions = batch.wallets.reduce(
        (total, wallet) => total + wallet.actions.length,
        0,
      );
      const risk = assertPreparationAllInRiskWithinCap({
        batch,
        usdMicrosPerEth: 2_000_000_000n,
        allInRiskCapUsdMicros: 60_000_000n,
        completedReceipts: historical,
      });

      assert.equal(historical.length, 1);
      assert.equal(remainingActions, 19);
      assert.equal(historical.length + remainingActions, 20);
      assert.equal(completedPreparationGasWei(historical), 21_000n);
      assert.equal(risk.completedPreparationGasWei, 21_000n);
      assert.equal(fixture.vault.values.size, 0);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a persisted FINAL receipt moves to a different canonical block", async () => {
    const fixture = await recoveryFixture();
    try {
      await createTerminalRecoveryRecord(fixture.journal, fixture.vaultRef);
      fixture.vault.values.set(fixture.vaultRef, RAW);
      await assert.rejects(
        recoverPreparationRecords({
          journal: fixture.journal,
          vault: fixture.vault,
          probe: async () => unknownProbe(1n),
          waitForReceipt: async () => ({
            ...canonicalReceipt(),
            blockHash: `0x${"44".repeat(32)}` as Hex32,
          }),
          broadcaster: { broadcast: async () => accepted() },
          assertMarkers: async () => undefined,
          now: () => "2026-08-20T00:00:02.000Z",
        }),
        /receipt changed after restart/u,
      );
      assert.equal(fixture.vault.values.get(fixture.vaultRef), RAW);
      assert.equal((await fixture.journal.list())[0]?.state, "FINAL");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("safely clears a crash after PREPARED but before vault.put without broadcasting", async () => {
    const fixture = await recoveryFixture();
    try {
      await createRecoveryRecord(fixture.journal, fixture.vaultRef);
      let broadcasts = 0;
      const receipts = await recoverPreparationRecords({
        journal: fixture.journal,
        vault: fixture.vault,
        probe: async () => unknownProbe(),
        waitForReceipt: async () => canonicalReceipt(),
        broadcaster: {
          broadcast: async () => {
            broadcasts += 1;
            return accepted();
          },
        },
        assertMarkers: async () => undefined,
        now: () => "2026-08-20T00:00:01.000Z",
      });
      assert.equal(receipts.length, 0);
      assert.equal(broadcasts, 0);
      await assertNoUnresolvedPreparationRecords(fixture.journal);
      assert.equal((await fixture.journal.list())[0]?.state, "CLEARED");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("recovers crash/UNKNOWN with the exact same raw before allowing new preparation", async () => {
    const fixture = await recoveryFixture();
    try {
      await createRecoveryRecord(fixture.journal, fixture.vaultRef);
      fixture.vault.values.set(fixture.vaultRef, RAW);
      const [created] = await fixture.journal.list();
      assert.ok(created);
      const stored = await fixture.journal.transition(
        created,
        "STORED",
        "2026-08-20T00:00:01.000Z",
      );
      await fixture.journal.transition(stored, "UNKNOWN", "2026-08-20T00:00:02.000Z");

      const replayed: string[] = [];
      let markerChecks = 0;
      const receipts = await recoverPreparationRecords({
        journal: fixture.journal,
        vault: fixture.vault,
        probe: async () => unknownProbe(),
        waitForReceipt: async () => canonicalReceipt(),
        broadcaster: {
          broadcast: async (raw) => {
            replayed.push(raw);
            return accepted();
          },
        },
        assertMarkers: async () => {
          markerChecks += 1;
        },
        now: () => "2026-08-20T00:00:03.000Z",
      });
      assert.deepEqual(replayed, [RAW]);
      assert.equal(markerChecks, 1);
      assert.deepEqual(receipts, [canonicalReceipt()]);
      assert.equal(fixture.vault.values.size, 0);
      assert.equal((await fixture.journal.list())[0]?.state, "FINAL");
      await assertNoUnresolvedPreparationRecords(fixture.journal);

      const serialized = await readFile(
        join(fixture.directory, "journal", `${TX_HASH.slice(2)}.json`),
        "utf8",
      );
      assert.equal(serialized.includes(RAW), false);
      assert.equal(/private.?key|raw.?transaction/iu.test(serialized), false);
      await assert.rejects(
        fixture.journal.create({
          txHash: TX_HASH,
          walletAddress: WALLET,
          nonce: "0",
          action: "WRAP_WETH",
          vaultRef: fixture.vaultRef,
          createdAt: "2026-08-20T00:00:04.000Z",
        }),
        /non-cleared recovery attempt/,
      );
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("waits for a known transaction and never rebroadcasts it", async () => {
    const fixture = await recoveryFixture();
    try {
      await createRecoveryRecord(fixture.journal, fixture.vaultRef);
      fixture.vault.values.set(fixture.vaultRef, RAW);
      let broadcasts = 0;
      let waits = 0;
      await recoverPreparationRecords({
        journal: fixture.journal,
        vault: fixture.vault,
        probe: async () => ({ ...unknownProbe(), transactionKnown: true }),
        waitForReceipt: async () => {
          waits += 1;
          return canonicalReceipt();
        },
        broadcaster: {
          broadcast: async () => {
            broadcasts += 1;
            return accepted();
          },
        },
        assertMarkers: async () => undefined,
        now: () => "2026-08-20T00:00:03.000Z",
      });
      assert.equal(waits, 1);
      assert.equal(broadcasts, 0);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("terminalizes a canonical status-0 preparation receipt and removes the encrypted raw", async () => {
    const fixture = await recoveryFixture();
    try {
      await createRecoveryRecord(fixture.journal, fixture.vaultRef);
      fixture.vault.values.set(fixture.vaultRef, RAW);
      await assert.rejects(
        recoverPreparationRecords({
          journal: fixture.journal,
          vault: fixture.vault,
          probe: async () => ({ ...unknownProbe(), transactionKnown: true }),
          waitForReceipt: async () => ({ ...canonicalReceipt(), status: 0 }),
          broadcaster: { broadcast: async () => accepted() },
          assertMarkers: async () => undefined,
          now: () => "2026-08-20T00:00:03.000Z",
        }),
        /reverted canonically/u,
      );
      assert.equal((await fixture.journal.list())[0]?.state, "FINAL_REVERTED");
      assert.equal((await fixture.journal.unresolved()).length, 0);
      assert.equal(fixture.vault.values.size, 0);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("stops when the nonce was consumed without the expected receipt", async () => {
    const fixture = await recoveryFixture();
    try {
      await createRecoveryRecord(fixture.journal, fixture.vaultRef);
      fixture.vault.values.set(fixture.vaultRef, RAW);
      await assert.rejects(
        recoverPreparationRecords({
          journal: fixture.journal,
          vault: fixture.vault,
          probe: async () => ({ ...unknownProbe(), latestNonce: 1n, pendingNonce: 1n }),
          waitForReceipt: async () => canonicalReceipt(),
          broadcaster: { broadcast: async () => accepted() },
          assertMarkers: async () => undefined,
          now: () => "2026-08-20T00:00:03.000Z",
        }),
        /nonce was consumed without its canonical receipt/,
      );
      assert.equal((await fixture.journal.unresolved()).length, 1);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("clears deterministic REJECTED only after nonce remains unchanged", async () => {
    const fixture = await recoveryFixture();
    try {
      await createRecoveryRecord(fixture.journal, fixture.vaultRef);
      fixture.vault.values.set(fixture.vaultRef, RAW);
      const receipts = await recoverPreparationRecords({
        journal: fixture.journal,
        vault: fixture.vault,
        probe: async () => unknownProbe(),
        waitForReceipt: async () => canonicalReceipt(),
        broadcaster: {
          broadcast: async () => ({ ...accepted(), state: "REJECTED" }),
        },
        assertMarkers: async () => undefined,
        now: () => "2026-08-20T00:00:03.000Z",
      });
      assert.equal(receipts.length, 0);
      assert.equal((await fixture.journal.list())[0]?.state, "CLEARED");
      assert.equal(fixture.vault.values.size, 0);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("keeps a CLEARED attempt as audit history and safely reuses the same signed hash", async () => {
    const fixture = await recoveryFixture();
    try {
      await createRecoveryRecord(fixture.journal, fixture.vaultRef);
      await recoverPreparationRecords({
        journal: fixture.journal,
        vault: fixture.vault,
        probe: async () => unknownProbe(),
        waitForReceipt: async () => canonicalReceipt(),
        broadcaster: { broadcast: async () => accepted() },
        assertMarkers: async () => undefined,
        now: () => "2026-08-20T00:00:01.000Z",
      });

      const second = await fixture.journal.create({
        txHash: TX_HASH,
        walletAddress: WALLET,
        nonce: "0",
        action: "WRAP_WETH",
        vaultRef: fixture.vaultRef,
        createdAt: "2026-08-20T00:00:02.000Z",
      });
      assert.equal(second.attempt, 2);
      fixture.vault.values.set(fixture.vaultRef, RAW);
      let broadcasts = 0;
      const receipts = await recoverPreparationRecords({
        journal: fixture.journal,
        vault: fixture.vault,
        probe: async () => unknownProbe(),
        waitForReceipt: async () => canonicalReceipt(),
        broadcaster: {
          broadcast: async (raw) => {
            broadcasts += 1;
            assert.equal(raw, RAW);
            return accepted();
          },
        },
        assertMarkers: async () => undefined,
        now: () => "2026-08-20T00:00:03.000Z",
      });

      assert.equal(broadcasts, 1);
      assert.deepEqual(receipts, [canonicalReceipt()]);
      assert.deepEqual(
        (await fixture.journal.list()).map((record) => [record.attempt, record.state]),
        [
          [1, "CLEARED"],
          [2, "FINAL"],
        ],
      );
      assert.deepEqual((await readdir(join(fixture.directory, "journal"))).sort(), [
        `${TX_HASH.slice(2)}.2.json`,
        `${TX_HASH.slice(2)}.json`,
      ]);
      assert.equal(fixture.vault.values.size, 0);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("rechecks markers immediately before recovery broadcast and retains unresolved raw on revoke", async () => {
    const fixture = await recoveryFixture();
    try {
      await createRecoveryRecord(fixture.journal, fixture.vaultRef);
      fixture.vault.values.set(fixture.vaultRef, RAW);
      let broadcasts = 0;
      await assert.rejects(
        recoverPreparationRecords({
          journal: fixture.journal,
          vault: fixture.vault,
          probe: async () => unknownProbe(),
          waitForReceipt: async () => canonicalReceipt(),
          broadcaster: {
            broadcast: async () => {
              broadcasts += 1;
              return accepted();
            },
          },
          assertMarkers: async () => {
            throw new Error("production arm marker revoked");
          },
          now: () => "2026-08-20T00:00:03.000Z",
        }),
        /marker revoked/,
      );
      assert.equal(broadcasts, 0);
      assert.equal((await fixture.journal.unresolved())[0]?.state, "BROADCASTING");
      assert.equal(fixture.vault.values.get(fixture.vaultRef), RAW);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
