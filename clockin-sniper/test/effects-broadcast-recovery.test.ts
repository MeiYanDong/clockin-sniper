import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBytes, keccak256 } from "ethers";
import {
  SameRawBroadcaster,
  type BroadcastProviderIdentity,
  type SameRawProvider,
} from "../src/broadcast/same-raw-broadcaster.js";
import {
  UnknownRecoveryManager,
  type RecoveryProbeSnapshot,
} from "../src/broadcast/unknown-recovery.js";
import type {
  Address,
  Hex32,
  LaunchIdentity,
  TxAttempt,
  WalletLane,
} from "../src/core/canonical.js";
import {
  buildEntryEffect,
  type EntryReceiptEvidence,
} from "../src/effects/entry-effect-builder.js";
import {
  reconcileEffectCanonicality,
  reconcileLaunchAndWalletAfterReorg,
} from "../src/effects/reorg-reconciler.js";
import { LatencyTimeline, type LatencyMilestone } from "../src/observability/latency-timeline.js";

const RAW = "0x010203" as const;
const TX_HASH = keccak256(getBytes(RAW)) as Hex32;
const WRONG_HASH = `0x${"99".repeat(32)}` as Hex32;
const BLOCK_HASH = `0x${"22".repeat(32)}` as Hex32;
const NEXT_BLOCK_HASH = `0x${"23".repeat(32)}` as Hex32;
const GENESIS_HASH = `0x${"00".repeat(32)}` as const;
const WALLET = `0x${"33".repeat(20)}` as Address;
const TOKEN = `0x${"44".repeat(20)}` as Address;
const PRINCIPAL = `0x${"55".repeat(20)}` as Address;
const NOW = "2026-08-16T00:00:00.000Z";

function receipt(overrides: Partial<EntryReceiptEvidence> = {}): EntryReceiptEvidence {
  return {
    strategyId: "clockin",
    intentId: "intent-1",
    attemptId: "attempt-1",
    launchId: "launch-1",
    laneId: "lane-1",
    walletAddress: WALLET,
    tokenAddress: TOKEN,
    principalAsset: PRINCIPAL,
    principalAssetKind: "NATIVE",
    entryRouteId: "launch-pool-v1",
    expectedSignedTxHash: TX_HASH,
    receiptTxHash: TX_HASH,
    receiptStatus: 1,
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    transactionIndex: 2n,
    gasUsed: 10n,
    effectiveGasPriceRaw: 10n,
    principalBalanceBeforeRaw: 10_000n,
    principalBalanceAfterRaw: 4_900n,
    tokenBalanceBeforeRaw: 200n,
    tokenBalanceAfterRaw: 800n,
    transferLogTokenOutRaw: 600n,
    plannedPrincipalRaw: 5_000n,
    declaredFeeBps: 4_000,
    evidenceIds: ["receipt", "balances", "logs"],
    observedAt: NOW,
    finality: "PROVISIONAL",
    ...overrides,
  };
}

describe("receipt-to-effect economic truth", () => {
  it("creates a position only from successful positive and reconciled token delivery", () => {
    const result = buildEntryEffect(receipt());
    assert.equal(result.effect.result, "SUCCESS");
    assert.equal(result.effect.canonicality, "PROVISIONAL");
    assert.equal(result.principalSpentRaw, 5_000n);
    assert.equal(result.principalRefundRaw, 0n);
    assert.equal(result.gasCostRaw, 100n);
    assert.equal(result.positionLot?.quantityRaw, "600");
    assert.deepEqual(result.effect.positionLotIds, [result.positionLot?.lotId]);
  });

  it("isolates receipt delivery from dust and disputes only a receipt amount the balance cannot cover", () => {
    const reverted = buildEntryEffect(receipt({ receiptStatus: 0 }));
    assert.equal(reverted.effect.result, "REVERTED");
    assert.equal(reverted.positionLot, undefined);

    const empty = buildEntryEffect(
      receipt({ tokenBalanceAfterRaw: 200n, transferLogTokenOutRaw: 0n }),
    );
    assert.equal(empty.effect.result, "SUCCESS_NO_TOKENS");
    assert.equal(empty.positionLot, undefined);

    const dusted = buildEntryEffect(receipt({ transferLogTokenOutRaw: 599n }));
    assert.equal(dusted.effect.result, "SUCCESS");
    assert.equal(dusted.positionLot?.quantityRaw, "599");
    assert.equal(dusted.externalTokenDeltaRaw, 1n);
    assert.match(dusted.effect.evidenceIds.at(-1) ?? "", /external-token-delta-raw:1/u);

    const disputed = buildEntryEffect(receipt({ transferLogTokenOutRaw: 601n }));
    assert.equal(disputed.effect.result, "DISPUTED");
    assert.equal(disputed.positionLot, undefined);
  });

  it("rejects a receipt for a different signed transaction", () => {
    assert.throws(() => buildEntryEffect(receipt({ receiptTxHash: WRONG_HASH })), /does not match/);
  });

  it("revises a reorged effect and lot without deleting the original audit history", () => {
    const original = buildEntryEffect(receipt());
    assert.equal(
      reconcileEffectCanonicality(
        original.effect,
        original.positionLot,
        BLOCK_HASH,
        "2026-08-16T00:00:01.000Z",
      ),
      null,
    );
    const reorged = reconcileEffectCanonicality(
      original.effect,
      original.positionLot,
      NEXT_BLOCK_HASH,
      "2026-08-16T00:00:02.000Z",
    );
    assert.equal(reorged?.effect.revision, 2);
    assert.equal(reorged?.effect.canonicality, "REORGED");
    assert.equal(reorged?.effect.positionLotIds.length, 0);
    assert.equal(reorged?.positionLot?.state, "UNKNOWN");
    assert.equal(reorged?.auditEvent.parentEffectId, original.effect.effectId);
  });

  it("rechecks identity, nonces, balances and unsent validity after a reorg", () => {
    const original = buildEntryEffect(receipt({ entryNonce: 7n }));
    if (original.positionLot === undefined) throw new Error("fixture position lot missing");
    const identity: LaunchIdentity = Object.freeze({
      candidateId: "candidate-1",
      strategyId: "clockin",
      revision: 1,
      factoryProfileId: "factory-1",
      creator: WALLET,
      tokenAddress: TOKEN,
      poolAddress: PRINCIPAL,
      name: "ClockIn",
      symbol: "CLOCKIN",
      metadataUri: "ipfs://clockin",
      imageHash: BLOCK_HASH,
      blockNumber: "99",
      blockHash: BLOCK_HASH,
      transactionHash: TX_HASH,
      transactionIndex: "0",
      logIndex: "0",
      evidenceIds: ["launch"],
      observedAt: NOW,
      launchId: "launch-1",
      tokenRuntimeCodeHash: BLOCK_HASH,
      poolRuntimeCodeHash: BLOCK_HASH,
      mechanismProfileId: "mechanism-1",
      identityPolicyHash: "identity-hash",
      configHash: "config-hash",
      frozenAt: NOW,
      state: "FROZEN",
    });
    const lane: WalletLane = Object.freeze({
      laneId: "lane-2",
      strategyId: "clockin",
      revision: 1,
      walletId: "entry-02",
      address: WALLET,
      role: "CLOCKIN_ENTRY",
      trancheNumber: 2,
      maxPrincipalRaw: "5000",
      evidenceIds: ["budget"],
      state: "FEE_ELIGIBLE",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const reconciled = reconcileLaunchAndWalletAfterReorg({
      identity,
      effect: original.effect,
      lot: original.positionLot,
      canonicalReceiptBlockHash: NEXT_BLOCK_HASH,
      walletAddress: WALLET,
      latestNonce: 8n,
      pendingNonce: 8n,
      tokenBalanceRaw: 0n,
      principalBalanceRaw: 4_900n,
      unsentLanes: [lane],
      newValiditySatisfied: false,
      evidenceIds: ["nonce-read", "balance-read"],
      observedAt: "2026-08-16T00:00:03.000Z",
    });
    assert.equal(reconciled.identity.state, "REORG_RECONCILE");
    assert.equal(reconciled.effectRevision?.effect.canonicality, "REORGED");
    assert.equal(reconciled.walletReadback.latestNonce, 8n);
    assert.equal(reconciled.unsentLaneStates[0]?.state, "EXPIRED");
  });
});

class FixtureProvider implements SameRawProvider {
  readonly sent: `0x${string}`[] = [];

  constructor(
    readonly providerId: string,
    readonly region: string,
    readonly identity: BroadcastProviderIdentity,
    readonly handler: () => Promise<`0x${string}`>,
  ) {}

  async probeIdentity(): Promise<BroadcastProviderIdentity> {
    return this.identity;
  }

  async sendRawTransaction(rawTransaction: `0x${string}`): Promise<`0x${string}`> {
    this.sent.push(rawTransaction);
    return this.handler();
  }
}

function identity(overrides: Partial<BroadcastProviderIdentity> = {}): BroadcastProviderIdentity {
  return {
    chainId: 4_663,
    genesisHash: GENESIS_HASH,
    writeCapable: true,
    observedAt: NOW,
    ...overrides,
  };
}

describe("same-raw multi-route broadcast", () => {
  it("precomputes one hash, probes chain identity and fans out byte-for-byte", async () => {
    const providers = [
      new FixtureProvider("sequencer", "us-east", identity(), async () => TX_HASH),
      new FixtureProvider("rpc", "us-east", identity(), async () => TX_HASH),
    ];
    let clock = 0;
    const broadcaster = new SameRawBroadcaster({
      providers,
      expectedChainId: 4_663,
      expectedGenesisHash: GENESIS_HASH,
      now: () => (clock += 2),
    });
    await broadcaster.preflight();
    const result = await broadcaster.broadcast(RAW);
    assert.equal(result.txHash, TX_HASH);
    assert.equal(result.state, "ACCEPTED");
    assert.deepEqual(
      providers.map((provider) => provider.sent),
      [[RAW], [RAW]],
    );
    assert.ok(result.outcomes.every((outcome) => outcome.txHash === TX_HASH));
    assert.equal(JSON.stringify(result).includes(RAW), false);
  });

  it("requires preflight and rejects wrong chain, genesis or write capability", async () => {
    const provider = new FixtureProvider("rpc", "local", identity(), async () => TX_HASH);
    const unproven = new SameRawBroadcaster({
      providers: [provider],
      expectedChainId: 4_663,
      expectedGenesisHash: GENESIS_HASH,
    });
    await assert.rejects(unproven.broadcast(RAW), /preflight/);
    for (const wrong of [
      identity({ chainId: 1 }),
      identity({ genesisHash: BLOCK_HASH }),
      identity({ writeCapable: false }),
    ]) {
      const broadcaster = new SameRawBroadcaster({
        providers: [new FixtureProvider("bad", "local", wrong, async () => TX_HASH)],
        expectedChainId: 4_663,
        expectedGenesisHash: GENESIS_HASH,
      });
      await assert.rejects(broadcaster.preflight());
    }
  });

  it("classifies known/unknown/rejected and requires all deterministic failures for rejected", async () => {
    const cases = [
      {
        errors: [new Error("already known"), new Error("invalid sender")],
        expected: "KNOWN",
      },
      { errors: [new Error("timeout"), new Error("invalid sender")], expected: "UNKNOWN" },
      {
        errors: [new Error("insufficient funds"), new Error("invalid sender")],
        expected: "REJECTED",
      },
    ] as const;
    for (const scenario of cases) {
      const providers = scenario.errors.map(
        (error, index) =>
          new FixtureProvider(`provider-${index}`, "local", identity(), async () => {
            throw error;
          }),
      );
      const broadcaster = new SameRawBroadcaster({
        providers,
        expectedChainId: 4_663,
        expectedGenesisHash: GENESIS_HASH,
      });
      await broadcaster.preflight();
      assert.equal((await broadcaster.broadcast(RAW)).state, scenario.expected);
    }
  });

  it("fences a provider hash mismatch as UNKNOWN because submission cannot be disproved", async () => {
    const broadcaster = new SameRawBroadcaster({
      providers: [new FixtureProvider("wrong", "local", identity(), async () => WRONG_HASH)],
      expectedChainId: 4_663,
      expectedGenesisHash: GENESIS_HASH,
    });
    await broadcaster.preflight();
    const result = await broadcaster.broadcast(RAW);
    assert.equal(result.state, "UNKNOWN");
    assert.equal(result.outcomes[0]?.result, "UNKNOWN");
    assert.match(result.outcomes[0]?.reason ?? "", /different/);
  });

  it("keeps internal and unfamiliar provider failures UNKNOWN", async () => {
    for (const error of [
      new Error("JSON-RPC -32603 internal error"),
      new Error("upstream refused this request for an unfamiliar reason"),
    ]) {
      const broadcaster = new SameRawBroadcaster({
        providers: [
          new FixtureProvider("unknown", "local", identity(), async () => {
            throw error;
          }),
        ],
        expectedChainId: 4_663,
        expectedGenesisHash: GENESIS_HASH,
      });
      await broadcaster.preflight();
      const result = await broadcaster.broadcast(RAW);
      assert.equal(result.state, "UNKNOWN");
      assert.equal(result.outcomes[0]?.result, "UNKNOWN");
    }
  });

  it("requires every route to prove a pre-acceptance rejection before returning REJECTED", async () => {
    const broadcaster = new SameRawBroadcaster({
      providers: [
        new FixtureProvider("deterministic", "local", identity(), async () => {
          throw new Error("invalid sender");
        }),
        new FixtureProvider("unproven", "local", identity(), async () => {
          throw new Error("provider policy failure");
        }),
      ],
      expectedChainId: 4_663,
      expectedGenesisHash: GENESIS_HASH,
    });
    await broadcaster.preflight();
    const result = await broadcaster.broadcast(RAW);
    assert.equal(result.state, "UNKNOWN");
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.result),
      ["REJECTED", "UNKNOWN"],
    );
  });
});

function unknownAttempt(): TxAttempt {
  return {
    attemptId: "attempt-1",
    strategyId: "clockin",
    revision: 1,
    intentId: "intent-1",
    planId: "plan-1",
    launchId: "launch-1",
    laneId: "lane-1",
    walletAddress: WALLET,
    nonce: "7",
    operation: "INITIAL",
    signedTxHash: TX_HASH,
    payloadHash: "payload-hash",
    vaultRef: "/external/vault/tx.vault",
    transportEvents: [],
    state: "UNKNOWN",
    evidenceIds: ["transport-timeout"],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function recoveryProbe(overrides: Partial<RecoveryProbeSnapshot> = {}): RecoveryProbeSnapshot {
  return {
    receipt: null,
    transactionKnown: false,
    latestNonce: 7n,
    pendingNonce: 7n,
    principalBalanceRaw: 10_000n,
    tokenBalanceRaw: 0n,
    ...overrides,
  };
}

describe("UNKNOWN same-raw recovery", () => {
  it("replays only the encrypted original payload and never changes txHash or nonce", async () => {
    let replayed: string | undefined;
    const manager = new UnknownRecoveryManager({
      probe: { snapshot: async () => recoveryProbe() },
      vault: {
        get: async (reference, hash) => {
          assert.equal(reference, "/external/vault/tx.vault");
          assert.equal(hash, TX_HASH);
          return RAW;
        },
      },
      broadcaster: {
        broadcast: async (raw) => {
          replayed = raw;
          return { txHash: TX_HASH };
        },
      },
    });
    const result = await manager.recover(unknownAttempt(), 2_000, 1_500);
    assert.equal(result.state, "REBROADCASTED");
    assert.equal(result.txHash, TX_HASH);
    assert.equal(replayed, RAW);
    assert.equal(result.nonceLeaseMustRemain, true);
    assert.equal(result.reservationMustRemain, true);
  });

  it("does not replay a known transaction and keeps expired ambiguity under background audit", async () => {
    for (const [snapshot, nowMs, expected] of [
      [recoveryProbe({ transactionKnown: true, pendingNonce: 8n }), 1_500, "PENDING"],
      [recoveryProbe(), 2_001, "EXPIRED_UNRESOLVED"],
      [
        recoveryProbe({ receipt: { txHash: TX_HASH, blockHash: BLOCK_HASH, status: 1 } }),
        1_500,
        "RECEIPT_FOUND",
      ],
    ] as const) {
      let replayed = false;
      const manager = new UnknownRecoveryManager({
        probe: { snapshot: async () => snapshot },
        vault: { get: async () => RAW },
        broadcaster: {
          broadcast: async () => {
            replayed = true;
            return { txHash: TX_HASH };
          },
        },
      });
      const result = await manager.recover(unknownAttempt(), 2_000, nowMs);
      assert.equal(result.state, expected);
      assert.equal(replayed, false);
      assert.equal(result.backgroundRecheckRequired, expected !== "RECEIPT_FOUND");
    }
  });

  it("never replays when either canonical nonce no longer equals the UNKNOWN attempt nonce", async () => {
    for (const snapshot of [
      recoveryProbe({ latestNonce: 8n, pendingNonce: 8n }),
      recoveryProbe({ latestNonce: 7n, pendingNonce: 8n }),
      recoveryProbe({ latestNonce: 8n, pendingNonce: 7n }),
      recoveryProbe({ latestNonce: 6n, pendingNonce: 6n }),
    ]) {
      let vaultRead = false;
      let replayed = false;
      const manager = new UnknownRecoveryManager({
        probe: { snapshot: async () => snapshot },
        vault: {
          get: async () => {
            vaultRead = true;
            return RAW;
          },
        },
        broadcaster: {
          broadcast: async () => {
            replayed = true;
            return { txHash: TX_HASH };
          },
        },
      });
      const result = await manager.recover(unknownAttempt(), 2_000, 1_500);
      assert.equal(result.state, "NONCE_MISMATCH_UNRESOLVED");
      assert.equal(result.backgroundRecheckRequired, true);
      assert.equal(result.nonceLeaseMustRemain, true);
      assert.equal(result.reservationMustRemain, true);
      assert.equal(vaultRead, false);
      assert.equal(replayed, false);
    }
  });

  it("rechecks live authorization immediately before same-raw broadcast", async () => {
    const sequence: string[] = [];
    const manager = new UnknownRecoveryManager({
      probe: { snapshot: async () => recoveryProbe() },
      vault: {
        get: async () => {
          sequence.push("vault");
          return RAW;
        },
      },
      beforeBroadcast: async () => {
        sequence.push("approval");
        throw new Error("runtime approvals revoked");
      },
      broadcaster: {
        broadcast: async () => {
          sequence.push("broadcast");
          return { txHash: TX_HASH };
        },
      },
    });
    await assert.rejects(
      () => manager.recover(unknownAttempt(), 2_000, 1_500),
      /runtime approvals revoked/u,
    );
    assert.deepEqual(sequence, ["vault", "approval"]);
  });
});

describe("segmented latency timeline", () => {
  it("calculates source-to-wire p50/p95/p99 by provider, region and profile", () => {
    const timeline = new LatencyTimeline();
    const from: LatencyMilestone = "PROVIDER_RECEIVE";
    const to: LatencyMilestone = "FIRST_WIRE_START";
    for (let index = 1; index <= 100; index += 1) {
      timeline.record({
        traceId: `trace-${index}`,
        providerId: "rpc-a",
        region: "us-east",
        profileId: "clockin-v1",
        milestone: from,
        monotonicMs: 1_000,
      });
      timeline.record({
        traceId: `trace-${index}`,
        providerId: "rpc-a",
        region: "us-east",
        profileId: "clockin-v1",
        milestone: to,
        monotonicMs: 1_000 + index,
      });
    }
    const summary = timeline.summarize(from, to)[0];
    assert.equal(summary?.p50Ms, 50);
    assert.equal(summary?.p95Ms, 95);
    assert.equal(summary?.p99Ms, 99);
    assert.equal(summary?.count, 100);
    assert.equal(timeline.duration("missing", from, to), null);
  });
});
