import assert from "node:assert/strict";
import { chmod, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Wallet, keccak256 } from "ethers";

import { CanonicalInvariantError } from "../src/core/canonical.js";
import { SqliteStore } from "../src/persistence/sqlite-store.js";
import type { JsonRpcRequester } from "../src/rpc/types.js";
import {
  generateWalletManifest,
  verifyManifestKeyCorrespondence,
  type WalletManifest,
} from "../src/wallets/wallet-manifest.js";
import {
  assertFreshPriceSnapshot,
  freezePriceSnapshot,
  manualPriceSnapshot,
} from "../src/wallets/price-snapshot.js";
import { inspectWalletReadiness } from "../src/wallets/readiness.js";
import { SignedTxVault } from "../src/wallets/signed-tx-vault.js";
import { WalletTransactionCoordinator } from "../src/wallets/transaction-coordinator.js";

const NOW = "2026-08-16T00:00:00.000Z";

async function tempDirectory(name: string): Promise<string> {
  const directory = join(
    tmpdir(),
    `clockin-${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(directory, { recursive: true });
  return directory;
}

function nonSecretManifest(count = 10): WalletManifest {
  return Object.freeze({
    revision: 1,
    generatedAt: NOW,
    entries: Object.freeze(
      Array.from({ length: count }, (_, index) =>
        Object.freeze({
          walletId: `entry-${String(index + 1).padStart(2, "0")}`,
          address: `0x${String(index + 1).padStart(40, "0")}` as `0x${string}`,
          role: "CLOCKIN_ENTRY" as const,
          expectedChainId: 4663 as const,
        }),
      ),
    ),
  });
}

describe("wallet generation and manifest", () => {
  it("writes ten repository-external keys as 0600 and prints only verifiable addresses", async () => {
    const directory = await tempDirectory("wallets");
    const generated = Array.from({ length: 10 }, () => Wallet.createRandom());
    let index = 0;
    const manifest = await generateWalletManifest({
      secretDirectory: directory,
      walletFactory: () => generated[index++] as (typeof generated)[number],
      now: () => NOW,
    });
    assert.equal(manifest.entries.length, 10);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const entry of manifest.entries) {
      assert.equal((await stat(join(directory, `${entry.walletId}.key`))).mode & 0o777, 0o600);
      assert.equal(Object.hasOwn(entry, "privateKey"), false);
      assert.deepEqual(Object.keys(entry).sort(), [
        "address",
        "expectedChainId",
        "role",
        "walletId",
      ]);
    }
    assert.equal(
      (await verifyManifestKeyCorrespondence(manifest, directory)).every((entry) => entry.valid),
      true,
    );
    await assert.rejects(
      generateWalletManifest({
        secretDirectory: directory,
        walletFactory: () => Wallet.createRandom(),
      }),
      /EEXIST/,
    );
  });

  it("fails closed when a required key file is unreadable", async () => {
    const directory = await tempDirectory("unreadable-wallet");
    const wallet = Wallet.createRandom();
    const manifest = await generateWalletManifest({
      secretDirectory: directory,
      count: 1,
      walletFactory: () => wallet,
      now: () => NOW,
    });
    const keyPath = join(directory, "entry-01.key");
    await chmod(keyPath, 0o000);
    try {
      await assert.rejects(
        verifyManifestKeyCorrespondence(manifest, directory),
        /EACCES|permission/u,
      );
    } finally {
      await chmod(keyPath, 0o600);
    }
  });
});

describe("wallet readiness and price snapshot", () => {
  it("reports 10/10 principal, entry gas, exit gas and clean nonce readiness", async () => {
    const requester: JsonRpcRequester = {
      providerId: "fixture",
      async request<T>(method: string): Promise<T> {
        if (method === "eth_chainId") return "0x1237" as T;
        if (method === "eth_getBalance") return "0x989680" as T;
        if (method === "eth_getTransactionCount") return "0x0" as T;
        throw new Error(`unexpected ${method}`);
      },
    };
    const report = await inspectWalletReadiness(requester, nonSecretManifest(), {
      batchValueWei: 5_000_000n,
      entryGasLimit: 100n,
      entryMaxFeePerGasWei: 1n,
      approvalGasLimit: 50n,
      sellGasLimit: 100n,
      exitMaxFeePerGasWei: 1n,
      safetyMarginWei: 100n,
    });
    assert.equal(report.hotArmed, true);
    assert.equal(report.principalReadyWallets, 10);
    assert.equal(report.exitGasReadyWallets, 10);
    assert.equal(report.nonceCleanWallets, 10);
  });

  it("pinpoints an underfunded or pending wallet without blocking report construction", async () => {
    let pendingCalls = 0;
    const requester: JsonRpcRequester = {
      providerId: "fixture",
      async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
        if (method === "eth_chainId") return "0x1237" as T;
        if (method === "eth_getBalance") {
          return String(params[0]).endsWith("1") ? ("0x1" as T) : ("0x989680" as T);
        }
        if (method === "eth_getTransactionCount") {
          pendingCalls += 1;
          return pendingCalls === 2 ? ("0x1" as T) : ("0x0" as T);
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const report = await inspectWalletReadiness(requester, nonSecretManifest(2), {
      batchValueWei: 5_000_000n,
      entryGasLimit: 100n,
      entryMaxFeePerGasWei: 1n,
      approvalGasLimit: 50n,
      sellGasLimit: 100n,
      exitMaxFeePerGasWei: 1n,
      safetyMarginWei: 100n,
    });
    assert.equal(report.hotArmed, false);
    assert.equal(report.rows[0]?.shortfallWei, 5_000_349n);
    assert.equal(report.rows[0]?.unknownPending, true);
  });

  it("freezes 5U to wei from two fresh integer price sources", async () => {
    const nowMs = 1_000_000;
    const snapshot = await freezePriceSnapshot(
      async () => ({
        sourceId: "primary",
        usdMicrosPerEth: 2_000_000_000n,
        observedAtMs: nowMs - 1_000,
        evidenceId: "primary-1",
      }),
      async () => ({
        sourceId: "cross",
        usdMicrosPerEth: 2_010_000_000n,
        observedAtMs: nowMs - 2_000,
        evidenceId: "cross-1",
      }),
      {
        nominalUsdMicrosPerBatch: 5_000_000n,
        maximumAgeMs: 30_000,
        maximumDeviationBps: 100,
      },
      nowMs,
    );
    assert.equal(snapshot.batchValueWei, 2_500_000_000_000_000n);
    assert.doesNotThrow(() => assertFreshPriceSnapshot(snapshot, nowMs + 30_000));
    assert.throws(() => assertFreshPriceSnapshot(snapshot, nowMs + 30_001), /stale/);
  });

  it("rejects divergent sources and records manual fixed-wei implicit price", async () => {
    await assert.rejects(
      freezePriceSnapshot(
        async () => ({
          sourceId: "primary",
          usdMicrosPerEth: 2_000_000_000n,
          observedAtMs: 1,
          evidenceId: "primary-1",
        }),
        async () => ({
          sourceId: "cross",
          usdMicrosPerEth: 3_000_000_000n,
          observedAtMs: 1,
          evidenceId: "cross-1",
        }),
        {
          nominalUsdMicrosPerBatch: 5_000_000n,
          maximumAgeMs: 100,
          maximumDeviationBps: 100,
        },
        1,
      ),
      /deviation/,
    );
    const manual = manualPriceSnapshot(2n, 5_000_000n, 2_500_000_000n, 1, 100);
    assert.equal(manual.primary.sourceId, "operator-fixed-wei");
  });
});

describe("wallet nonce coordinator and signed transaction vault", () => {
  it("fences one writer and keeps UNKNOWN entry from creating an exit nonce", () => {
    const store = new SqliteStore(":memory:");
    const coordinator = new WalletTransactionCoordinator(store);
    const address = nonSecretManifest(1).entries[0]?.address as `0x${string}`;
    const epoch = coordinator.acquire(
      address,
      "executor-a",
      0n,
      0n,
      NOW,
      "2026-08-16T00:01:00.000Z",
    );
    const slot = coordinator.reserve(address, "executor-a", epoch, 0n, "ENTRY", "plan-1");
    const submitted = coordinator.transition(slot, "POSSIBLY_SUBMITTED");
    assert.throws(
      () => coordinator.transition(submitted, "RELEASED"),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "TRANSPORT_UNKNOWN",
    );
    assert.throws(
      () => coordinator.assertExitAllowed(address),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "NONCE_CONFLICT",
    );
    store.close();
  });

  it("rejects startup when latest and pending nonce disagree", () => {
    const store = new SqliteStore(":memory:");
    const coordinator = new WalletTransactionCoordinator(store);
    const address = nonSecretManifest(1).entries[0]?.address as `0x${string}`;
    assert.throws(
      () => coordinator.acquire(address, "executor-a", 0n, 1n, NOW, "2026-08-16T00:01:00.000Z"),
      /unknown pending nonce/,
    );
    store.close();
  });

  it("persists one-shot entry claims and unresolved nonce ownership across coordinator restart", () => {
    const store = new SqliteStore(":memory:");
    const first = new WalletTransactionCoordinator(store);
    const address = nonSecretManifest().entries[0]?.address;
    if (address === undefined) throw new Error("fixture wallet missing");
    const epoch = first.acquire(address, "executor-a", 7n, 7n, NOW, "2026-08-16T00:10:00Z");
    assert.equal(
      first.claimEntryIntent({
        strategyId: "clockin",
        launchId: "launch-1",
        walletAddress: address,
        intentId: "intent-1",
        createdAt: NOW,
      }),
      true,
    );
    assert.equal(
      first.claimEntryIntent({
        strategyId: "clockin",
        launchId: "launch-1",
        walletAddress: address,
        intentId: "intent-1",
        createdAt: NOW,
      }),
      false,
    );
    assert.throws(
      () =>
        first.claimEntryIntent({
          strategyId: "clockin",
          launchId: "launch-1",
          walletAddress: address,
          intentId: "intent-2",
          createdAt: NOW,
        }),
      /different entry intent/,
    );
    const slot = first.reserve(address, "executor-a", epoch, 7n, "ENTRY", "plan-1", NOW);
    first.transition(slot, "UNKNOWN", NOW);

    const restarted = new WalletTransactionCoordinator(store);
    assert.throws(() => restarted.assertExitAllowed(address), /unresolved/);
    assert.throws(
      () => restarted.reserve(address, "executor-a", epoch, 7n, "EXIT", "plan-2", NOW),
      /stale|already/,
    );
    store.close();
  });

  it("marks a nonce consumed only after canonical receipt and latest/pending readback agree", () => {
    const store = new SqliteStore(":memory:");
    const coordinator = new WalletTransactionCoordinator(store);
    const address = nonSecretManifest(1).entries[0]?.address;
    if (address === undefined) throw new Error("fixture wallet missing");
    const epoch = coordinator.acquire(address, "executor-a", 4n, 4n, NOW, "2026-08-16T00:10:00Z");
    const slot = coordinator.reserve(address, "executor-a", epoch, 4n, "ENTRY", "plan-4", NOW);
    const submitted = coordinator.transition(slot, "POSSIBLY_SUBMITTED", NOW);
    assert.throws(
      () =>
        coordinator.reconcileCanonicalReceipt(
          submitted,
          {
            receiptStatus: "SUCCESS",
            receiptCanonical: false,
            latestNonce: 5n,
            pendingNonce: 5n,
          },
          NOW,
        ),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "REORG_DETECTED",
    );
    assert.throws(
      () =>
        coordinator.reconcileCanonicalReceipt(
          submitted,
          {
            receiptStatus: "SUCCESS",
            receiptCanonical: true,
            latestNonce: 4n,
            pendingNonce: 5n,
          },
          NOW,
        ),
      /has not consumed/,
    );
    assert.equal(
      coordinator.reconcileCanonicalReceipt(
        submitted,
        {
          receiptStatus: "SUCCESS",
          receiptCanonical: true,
          latestNonce: 5n,
          pendingNonce: 5n,
        },
        NOW,
      ).state,
      "CONSUMED",
    );
    store.close();
  });

  it("keeps treasury sweep in a separate flat-position nonce flow", () => {
    const store = new SqliteStore(":memory:");
    const coordinator = new WalletTransactionCoordinator(store);
    const address = nonSecretManifest(1).entries[0]?.address;
    if (address === undefined) throw new Error("fixture wallet missing");
    const epoch = coordinator.acquire(
      address,
      "treasury-operator",
      9n,
      9n,
      NOW,
      "2026-08-16T00:10:00Z",
    );
    assert.throws(
      () =>
        coordinator.assertTreasurySweepAllowed({
          walletAddress: address,
          entryEnabled: true,
          openPositionCount: 0,
        }),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "STATE_TRANSITION_INVALID",
    );
    assert.throws(
      () =>
        coordinator.assertTreasurySweepAllowed({
          walletAddress: address,
          entryEnabled: false,
          openPositionCount: 1,
        }),
      /zero open positions/,
    );
    assert.doesNotThrow(() =>
      coordinator.assertTreasurySweepAllowed({
        walletAddress: address,
        entryEnabled: false,
        openPositionCount: 0,
      }),
    );
    assert.equal(
      coordinator.reserve(address, "treasury-operator", epoch, 9n, "TREASURY_SWEEP", "sweep-9", NOW)
        .purpose,
      "TREASURY_SWEEP",
    );
    store.close();
  });

  it("encrypts raw bytes in a 0600 vault and restores byte-for-byte same raw", async () => {
    const directory = await tempDirectory("vault");
    const key = new Uint8Array(32).fill(7);
    const vault = new SignedTxVault(directory, key);
    const raw = "0x01020304" as const;
    const txHash = keccak256(raw) as `0x${string}`;
    const reference = await vault.put(raw, NOW);
    assert.equal((await stat(reference)).mode & 0o777, 0o600);
    assert.equal(await vault.get(reference, txHash), raw);
    await assert.rejects(vault.get(reference, `0x${"0".repeat(64)}`), /metadata txHash/);
    const wrongVault = new SignedTxVault(directory, new Uint8Array(32).fill(8));
    await assert.rejects(wrongVault.get(reference, txHash));
    await vault.remove(reference);
    await assert.rejects(vault.get(reference, txHash), /ENOENT/);
  });

  it("retains unresolved vault payloads and removes only after final receipt or proven expiry", async () => {
    const directory = await tempDirectory("vault-cleanup");
    const vault = new SignedTxVault(directory, new Uint8Array(32).fill(9));
    const unresolvedRaw = "0x1112" as const;
    const unresolvedHash = keccak256(unresolvedRaw) as `0x${string}`;
    const unresolved = await vault.put(unresolvedRaw, NOW);
    assert.equal(
      await vault.cleanup(unresolved, {
        canonicalReceiptFinal: false,
        validityExpired: true,
        nonce: 7n,
        latestNonce: 7n,
        pendingNonce: 7n,
        droppedProven: false,
      }),
      "RETAINED",
    );
    assert.equal(await vault.get(unresolved, unresolvedHash), unresolvedRaw);
    assert.equal(
      await vault.cleanup(unresolved, {
        canonicalReceiptFinal: false,
        validityExpired: true,
        nonce: 7n,
        latestNonce: 8n,
        pendingNonce: 8n,
        droppedProven: false,
      }),
      "REMOVED",
    );
    await assert.rejects(vault.get(unresolved, unresolvedHash), /ENOENT/);

    const finalRaw = "0x1314" as const;
    const finalHash = keccak256(finalRaw) as `0x${string}`;
    const finalReference = await vault.put(finalRaw, NOW);
    assert.equal(
      await vault.cleanup(finalReference, {
        canonicalReceiptFinal: true,
        validityExpired: false,
        nonce: 8n,
        latestNonce: 8n,
        pendingNonce: 8n,
        droppedProven: false,
      }),
      "REMOVED",
    );
    await assert.rejects(vault.get(finalReference, finalHash), /ENOENT/);
  });
});
