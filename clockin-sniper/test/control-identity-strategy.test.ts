import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { keccak256 } from "ethers";

import { AddressCluster } from "../src/control/address-cluster.js";
import { evaluateTopicEmitterAtExactBlock } from "../src/control/factory-candidate-evaluator.js";
import {
  diffFactoryProfiles,
  FactoryRegistry,
  type FactoryProfileDraft,
} from "../src/control/factory-registry.js";
import {
  verifyBoundRouteCandidate,
  verifyRouteCandidate,
} from "../src/control/liquidity-channel.js";
import { SignalLedger } from "../src/control/signal-ledger.js";
import {
  EIP1967_IMPLEMENTATION_SLOT,
  diffProxyIdentity,
  fingerprintTopicEmitter,
  matchFactoryFamily,
} from "../src/control/topic-wide-channel.js";
import { verifyWebsiteTokenEvidence, WebsiteChannel } from "../src/control/website-channel.js";
import {
  CanonicalInvariantError,
  type LaunchCandidate,
  type WalletLane,
} from "../src/core/canonical.js";
import { authorizeEntryLane } from "../src/identity/authorization.js";
import {
  applyOfficialCaGate,
  evaluateClockInIdentity,
  freezeLaunchIdentity,
  markIdentityForReorg,
  reconcileOfficialCa,
  type ClockInIdentityPolicy,
} from "../src/identity/identity-binder.js";
import {
  assertClockInMechanism,
  profileMechanism,
  readMechanismSnapshot,
  type MechanismSnapshot,
} from "../src/identity/mechanism-profiler.js";
import type { Hex, JsonRpcRequester } from "../src/rpc/types.js";
import {
  CLOCKIN_STRATEGY_ID,
  selectCanonicalFirstOfficialLaunch,
  StrategyRouter,
} from "../src/strategies/strategy-router.js";

const FACTORY = `0x${"1".repeat(40)}` as Hex;
const CREATOR = `0x${"2".repeat(40)}` as Hex;
const TOKEN = `0x${"3".repeat(40)}` as Hex;
const OTHER_TOKEN = `0x${"4".repeat(40)}` as Hex;
const POOL = `0x${"5".repeat(40)}` as Hex;
const QUOTE = `0x${"6".repeat(40)}` as Hex;
const HASH_A = `0x${"a".repeat(64)}` as Hex;
const HASH_B = `0x${"b".repeat(64)}` as Hex;
const TX_HASH = `0x${"c".repeat(64)}` as Hex;
const NOW = "2026-08-16T00:00:00.000Z";
const AUTHORIZATION_SCOPE = {
  chainId: 4663,
  profileId: "factory-profile-1",
  profileRevision: 1,
  strategyConfigHash: "sha256:clockin-policy-v2",
  walletIds: ["entry-01", "entry-02"],
  identityGate: "HYBRID_CA_GATE",
} as const;
const AUTHORIZATION_RISK = {
  clockInBudgetUsdMicros: "50000000",
  allInRiskCapUsdMicros: "60000000",
  maximumLaneUsdMicros: "5000000",
  minimumLaneUsdMicros: "1000000",
  routineExitMaximumSlippageBps: 500,
  breakGlassExitMaximumSlippageBps: 2_000,
} as const;

function candidate(overrides: Partial<LaunchCandidate> = {}): LaunchCandidate {
  return Object.freeze({
    candidateId: "candidate-1",
    strategyId: CLOCKIN_STRATEGY_ID,
    revision: 1,
    factoryProfileId: "profile-1",
    creator: CREATOR,
    tokenAddress: TOKEN,
    poolAddress: POOL,
    name: "Clock In",
    symbol: "CLOCKIN",
    metadataUri: "ipfs://official-clockin/metadata.json",
    imageHash: HASH_A,
    blockNumber: "100",
    blockHash: HASH_A,
    transactionHash: TX_HASH,
    transactionIndex: "1",
    logIndex: "2",
    evidenceIds: ["signal-1"],
    observedAt: NOW,
    ...overrides,
  });
}

const policy: ClockInIdentityPolicy = Object.freeze({
  expectedNames: ["CLOCKIN", "Clock In"],
  expectedSymbols: ["CLOCKIN"],
  expectedCreators: [CREATOR],
  metadataIncludes: ["official-clockin"],
  tokenSuffixes: [TOKEN.slice(-6)],
  requireCreator: true,
  requireMetadata: true,
  requireTokenSuffix: true,
  policyRevision: 1,
});

function profileDraft(): FactoryProfileDraft {
  return Object.freeze({
    profileId: "profile-1",
    strategyId: CLOCKIN_STRATEGY_ID,
    revision: 1,
    chainId: 4663,
    address: FACTORY,
    deployedBlock: { state: "UNKNOWN" as const, reason: "not published", since: NOW },
    deploymentTxHash: { state: "UNKNOWN" as const, reason: "not published", since: NOW },
    deployer: { state: "UNKNOWN" as const, reason: "not published", since: NOW },
    runtimeCodeHash: HASH_A,
    proxyType: "NONE",
    implementationAddress: { state: "UNSUPPORTED" as const, reason: "not a proxy" },
    implementationCodeHash: { state: "UNSUPPORTED" as const, reason: "not a proxy" },
    adminAddress: { state: "UNSUPPORTED" as const, reason: "not a proxy" },
    launchEventTopic: HASH_B,
    eventAbiHash: HASH_B,
    adapterIds: {
      factory: "factory-v1",
      poolRead: "pool-v1",
      entry: "entry-v1",
      exit: "exit-v1",
      finalize: "finalize-v1",
    },
    quoteAssets: [QUOTE],
    lifecycle: ["LAUNCH", "ACTIVE_SALE", "FINALIZED", "EXTERNAL_AMM"] as const,
    state: "OBSERVED",
    evidenceIds: ["evidence-1"],
    lastVerifiedBlock: "100",
    createdAt: NOW,
  });
}

function mechanism(initialFeeBps = 4_000, window = 120): MechanismSnapshot {
  return Object.freeze({
    factoryCodeHash: HASH_A,
    poolCodeHash: HASH_B,
    initialFeeBps,
    floorFeeBps: initialFeeBps === 4_000 ? 0 : 100,
    decayWindowSeconds: window,
    decayModel: "LINEAR_TIME",
    inSniperWindow: true,
    buyCooldownSeconds: 20,
    cooldownScope: "PER_WALLET",
    eoaOnlySeconds: 120,
    windowMaxBuyBps: 500,
    currentWindowCapRaw: 1_000_000n,
    capScope: "PER_TX",
    quoteAsset: QUOTE,
    getterEvidenceIds: ["getter-1"],
  });
}

describe("control sentinel primitives", () => {
  it("deduplicates exact/backfill observations and orders canonical positions", () => {
    const ledger = new SignalLedger();
    const second = {
      strategyId: CLOCKIN_STRATEGY_ID,
      sourceKind: "exact_factory" as const,
      sourceId: FACTORY,
      observedAt: NOW,
      chainId: 4663,
      blockNumber: 100n,
      blockHash: HASH_A,
      transactionHash: TX_HASH,
      transactionIndex: 2n,
      logIndex: 1n,
      payload: { token: TOKEN },
    };
    const first = {
      ...second,
      transactionIndex: 1n,
      transactionHash: HASH_B,
      payload: { token: OTHER_TOKEN },
    };
    assert.ok(ledger.ingest(second));
    assert.ok(ledger.ingest(first));
    assert.equal(ledger.ingest(second), null);
    assert.equal(ledger.ordered()[0]?.transactionIndex, "1");
  });

  it("records removed signals as a new reconciliation revision", () => {
    const ledger = new SignalLedger();
    const input = {
      strategyId: CLOCKIN_STRATEGY_ID,
      sourceKind: "topic_wide" as const,
      sourceId: "all",
      observedAt: NOW,
      chainId: 4663,
      blockNumber: 100n,
      blockHash: HASH_A,
      transactionHash: TX_HASH,
      logIndex: 1n,
      payload: { emitter: FACTORY },
    };
    assert.equal(ledger.ingest(input)?.removed, false);
    const removed = ledger.ingest({ ...input, removed: true });
    assert.equal(removed?.removed, true);
    assert.equal(removed?.revision, 2);
  });

  it("requires an explicit profile state path and fails code drift closed", () => {
    const registry = new FactoryRegistry();
    registry.register(profileDraft());
    registry.transition("profile-1", "FINGERPRINTED", ["ev-2"], "101", NOW);
    registry.transition("profile-1", "PROFILE_MATCHED", ["ev-3"], "102", NOW);
    registry.transition("profile-1", "VERIFIED", ["ev-4"], "103", NOW);
    const armed = registry.transition("profile-1", "HOT_ARMED", ["ev-5"], "104", NOW);
    assert.equal(
      registry.assertExecutionReady("profile-1", armed.revision, HASH_A).state,
      "HOT_ARMED",
    );
    assert.throws(
      () => registry.assertExecutionReady("profile-1", armed.revision, HASH_B),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "FACTORY_CODE_DRIFT",
    );
  });

  it("automatically makes an armed profile stale when current code identity drifts", () => {
    const registry = new FactoryRegistry();
    registry.register(profileDraft());
    registry.transition("profile-1", "FINGERPRINTED", ["ev-2"], "101", NOW);
    registry.transition("profile-1", "PROFILE_MATCHED", ["ev-3"], "102", NOW);
    registry.transition("profile-1", "VERIFIED", ["ev-4"], "103", NOW);
    registry.transition("profile-1", "HOT_ARMED", ["ev-5"], "104", NOW);
    const stale = registry.observeCodeIdentity({
      profileId: "profile-1",
      actualRuntimeCodeHash: HASH_B,
      evidenceId: "code-read-105",
      blockNumber: "105",
      observedAt: NOW,
    });
    assert.equal(stale.state, "STALE_REVERIFY_REQUIRED");
    assert.throws(
      () => registry.assertExecutionReady("profile-1", stale.revision, HASH_B),
      /not HOT_ARMED/,
    );
    const changes = diffFactoryProfiles(registry.current("profile-1"), stale);
    assert.equal(changes.length, 0);
  });

  it("produces a stable profile diff without exposing field values", () => {
    const registry = new FactoryRegistry();
    const observed = registry.register(profileDraft());
    const fingerprinted = registry.transition("profile-1", "FINGERPRINTED", ["ev-2"], "101", NOW);
    const changes = diffFactoryProfiles(observed, fingerprinted);
    assert.deepEqual(
      changes.map((change) => change.field),
      ["state"],
    );
    assert.ok(changes.every((change) => change.previousHash.startsWith("sha256:")));
  });

  it("fingerprints a topic-wide emitter at one exact block without authorizing unknown code", async () => {
    const calls: { method: string; params: readonly unknown[] }[] = [];
    const requester: JsonRpcRequester = {
      providerId: "fixture",
      async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
        calls.push({ method, params });
        if (method === "eth_getCode") return "0x6001600055" as T;
        if (method === "eth_getStorageAt") return `0x${"0".repeat(64)}` as T;
        throw new Error(`unexpected ${method}`);
      },
    };
    const fingerprint = await fingerprintTopicEmitter(requester, {
      strategyId: CLOCKIN_STRATEGY_ID,
      emitter: FACTORY,
      blockNumber: 123n,
      observedAt: NOW,
      evidenceId: "signal-1",
    });
    assert.equal(calls[1]?.params[1], EIP1967_IMPLEMENTATION_SLOT);
    assert.equal(matchFactoryFamily(fingerprint, new Set(["0xdead"]), new Set()), "FINGERPRINTED");
    assert.equal(
      matchFactoryFamily(
        fingerprint,
        new Set([
          fingerprint.runtimeCodeHash.state === "KNOWN"
            ? fingerprint.runtimeCodeHash.value.toLowerCase()
            : "",
        ]),
        new Set(),
      ),
      "PROFILE_MATCHED",
    );
  });

  it("limits the address graph to reviewed one-hop relationships", () => {
    const cluster = new AddressCluster([CREATOR]);
    assert.throws(
      () =>
        cluster.add({
          from: CREATOR,
          to: TOKEN,
          relationshipType: "FUNDED_BY",
          sourceTxHash: TX_HASH,
          observedBlock: 100n,
          reviewState: "PENDING",
        }),
      /unreviewed funding/,
    );
    assert.equal(
      cluster.add({
        from: CREATOR,
        to: FACTORY,
        relationshipType: "DEPLOYED_BY",
        sourceTxHash: TX_HASH,
        observedBlock: 100n,
        reviewState: "APPROVED",
      }),
      true,
    );
    assert.equal(cluster.approvedAddresses().length, 2);
    assert.throws(
      () =>
        cluster.add({
          from: FACTORY,
          to: TOKEN,
          relationshipType: "CALLED_BY",
          sourceTxHash: HASH_A,
          observedBlock: 101n,
          reviewState: "APPROVED",
        }),
      /one approved hop/,
    );
  });

  it("creates a pending deployment candidate from a versioned approved root in one block", () => {
    const cluster = new AddressCluster({
      clusterId: "stonk-official-v1",
      revision: 3,
      rootAddresses: [CREATOR],
      evidenceIds: ["operator-review-1"],
      approvedAt: NOW,
    });
    const alert = cluster.observeDeployment({
      transactionHash: TX_HASH,
      from: CREATOR,
      to: null,
      contractAddress: FACTORY,
      blockNumber: 101n,
      status: "SUCCESS",
    });
    assert.equal(alert?.clusterRevision, 3);
    assert.equal(alert?.candidateAddress, FACTORY);
    assert.equal(cluster.edges()[0]?.reviewState, "PENDING");
    assert.equal(
      cluster.observeDeployment({
        transactionHash: HASH_A,
        from: TOKEN,
        to: null,
        contractAddress: POOL,
        blockNumber: 102n,
        status: "SUCCESS",
      }),
      null,
    );
    const adminAlert = cluster.observeAdminTransaction({
      transactionHash: HASH_B,
      from: CREATOR,
      to: POOL,
      blockNumber: 103n,
      status: "SUCCESS",
      relationshipType: "ADMINISTERED_BY",
    });
    assert.equal(adminAlert?.reason, "APPROVED_ADMIN_CHANGE");
    assert.equal(cluster.edges()[1]?.relationshipType, "ADMINISTERED_BY");
  });

  it("extracts only the configured website field and rejects a wrong chain", async () => {
    const url = "https://official.example/contracts.json";
    const channel = new WebsiteChannel([url], async () => ({
      status: 200,
      body: JSON.stringify({
        chainId: 4663,
        contracts: { clockin: TOKEN },
        decoy: OTHER_TOKEN,
      }),
      etag: '"v1"',
    }));
    const evidence = await channel.poll(
      {
        url,
        format: "json",
        path: "contracts.clockin",
        chainIdPath: "chainId",
        expectedChainId: 4663,
        field: "token",
      },
      NOW,
    );
    assert.equal(evidence.address.toLowerCase(), TOKEN.toLowerCase());
    await assert.rejects(
      channel.poll(
        {
          url,
          format: "json",
          path: "contracts.clockin",
          chainIdPath: "chainId",
          expectedChainId: 1,
          field: "token",
        },
        NOW,
      ),
      /does not match/,
    );
  });

  it("parses a configured JS runtime object, preserves address revisions and degrades safely", async () => {
    const url = "https://official.example/runtime.js";
    let body = `window.__RUNTIME_CONFIG__ = ${JSON.stringify({
      chainId: 4663,
      contracts: { clockin: TOKEN },
      decoy: OTHER_TOKEN,
    })};`;
    const channel = new WebsiteChannel([url], async () => ({ status: 200, body }));
    const rule = {
      url,
      format: "js_runtime_config" as const,
      path: "contracts.clockin",
      chainIdPath: "chainId",
      expectedChainId: 4663,
      field: "token" as const,
    };
    assert.equal((await channel.poll(rule, NOW)).address, TOKEN);
    body = `window.__RUNTIME_CONFIG__ = ${JSON.stringify({
      chainId: 4663,
      contracts: { clockin: OTHER_TOKEN },
    })};`;
    assert.equal((await channel.poll(rule, "2026-08-16T00:01:00.000Z")).address, OTHER_TOKEN);
    assert.equal(channel.history(url, "token").length, 2);
    body = "not valid runtime config";
    const failed = await channel.pollSafe(rule, "2026-08-16T00:02:00.000Z");
    assert.equal(failed.state, "ERROR");
    assert.equal(channel.history(url, "token").length, 2);
  });

  it("promotes a website CA only after token code and Factory family verification", async () => {
    const url = "https://official.example/contracts.json";
    const channel = new WebsiteChannel([url], async () => ({
      status: 200,
      body: JSON.stringify({ chainId: 4663, token: TOKEN }),
    }));
    const evidence = await channel.poll(
      {
        url,
        format: "json",
        path: "token",
        chainIdPath: "chainId",
        expectedChainId: 4663,
        field: "token",
      },
      NOW,
    );
    const tokenCode = "0x6002600055" as const;
    const verified = verifyWebsiteTokenEvidence({
      evidence,
      tokenRuntimeCode: tokenCode,
      allowedTokenRuntimeHashes: new Set([keccak256(tokenCode).toLowerCase()]),
      factoryProfileState: "VERIFIED",
    });
    assert.equal(verified.address, TOKEN);
    assert.throws(
      () =>
        verifyWebsiteTokenEvidence({
          evidence,
          tokenRuntimeCode: tokenCode,
          allowedTokenRuntimeHashes: new Set([HASH_A.toLowerCase()]),
          factoryProfileState: "OBSERVED",
        }),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "IDENTITY_INCOMPLETE",
    );
  });

  it("detects implementation, admin or beacon identity changes between exact-block reads", async () => {
    const requester: JsonRpcRequester = {
      providerId: "proxy-fixture",
      async request<T>(method: string): Promise<T> {
        if (method === "eth_getCode") return "0x6001600055" as T;
        if (method === "eth_getStorageAt") return `0x${"0".repeat(64)}` as T;
        throw new Error(`unexpected ${method}`);
      },
    };
    const previous = await fingerprintTopicEmitter(requester, {
      strategyId: CLOCKIN_STRATEGY_ID,
      emitter: FACTORY,
      blockNumber: 123n,
      observedAt: NOW,
      evidenceId: "proxy-123",
    });
    const current = Object.freeze({
      ...previous,
      revision: 2,
      adminAddress: Object.freeze({
        state: "KNOWN" as const,
        value: CREATOR,
        observedAt: NOW,
        evidenceIds: ["admin-change-124"],
      }),
    });
    assert.deepEqual(
      diffProxyIdentity(previous, current).map((change) => change.field),
      ["adminAddress"],
    );
  });

  it("does not promote a zero-liquidity pair to an exit route", () => {
    const allowed = new Map([[FACTORY.toLowerCase(), HASH_A.toLowerCase()]]);
    assert.throws(
      () =>
        verifyRouteCandidate(
          {
            launchId: "launch-1",
            tokenAddress: TOKEN,
            quoteAddress: QUOTE,
            poolAddress: POOL,
            factoryAddress: FACTORY,
            factoryCodeHash: HASH_A,
            poolCodeHash: HASH_B,
            reserveTokenRaw: 1n,
            reserveQuoteRaw: 0n,
            observedBlock: 100n,
          },
          allowed,
        ),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "LIQUIDITY_ZERO",
    );
  });

  it("binds an external route to launch, token, code identities, finalize and liquidity", () => {
    const input = {
      launchId: "launch-1",
      tokenAddress: TOKEN,
      quoteAddress: QUOTE,
      poolAddress: POOL,
      factoryAddress: FACTORY,
      factoryCodeHash: HASH_A,
      poolCodeHash: HASH_B,
      reserveTokenRaw: 100n,
      reserveQuoteRaw: 200n,
      finalizeTxHash: TX_HASH,
      observedBlock: 105n,
    } as const;
    const policy = {
      expectedLaunchId: "launch-1",
      expectedTokenAddress: TOKEN,
      allowedQuoteAddresses: new Set([QUOTE.toLowerCase()]),
      allowedFactoryCodeHashes: new Map([[FACTORY.toLowerCase(), HASH_A.toLowerCase()]]),
      allowedPoolCodeHashes: new Set([HASH_B.toLowerCase()]),
      requireFinalizeReceipt: true,
    } as const;
    assert.equal(verifyBoundRouteCandidate(input, policy).state, "VERIFIED");
    assert.throws(
      () => verifyBoundRouteCandidate({ ...input, tokenAddress: OTHER_TOKEN }, policy),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "IDENTITY_CONFLICT",
    );
  });

  it("fingerprints token, pool and emitter in the same block and rejects signature-only spoof code", async () => {
    const factoryCode = "0x6001600055";
    const tokenCode = "0x6002600055";
    const poolCode = "0x6003600055";
    const requester: JsonRpcRequester = {
      providerId: "topic-fixture",
      async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
        if (method === "eth_getStorageAt") return `0x${"0".repeat(64)}` as T;
        if (method === "eth_getCode") {
          const address = String(params[0]).toLowerCase();
          if (address === FACTORY.toLowerCase()) return factoryCode as T;
          if (address === TOKEN.toLowerCase()) return tokenCode as T;
          if (address === POOL.toLowerCase()) return poolCode as T;
        }
        throw new Error(`unexpected ${method} ${String(params[0])}`);
      },
    };
    const basePolicy = {
      policyId: "factory-family-v1",
      revision: 1,
      allowedFactoryRuntimeHashes: new Set([keccak256(factoryCode).toLowerCase()]),
      allowedImplementationHashes: new Set<string>(),
      allowedTokenRuntimeHashes: new Set([keccak256(tokenCode).toLowerCase()]),
      allowedPoolRuntimeHashes: new Set([keccak256(poolCode).toLowerCase()]),
    };
    const binding = {
      strategyId: CLOCKIN_STRATEGY_ID,
      emitter: FACTORY,
      tokenAddress: TOKEN,
      poolAddress: POOL,
      blockNumber: 123n,
      observedAt: NOW,
      evidenceId: "topic-signal-1",
    } as const;
    const verified = await evaluateTopicEmitterAtExactBlock(requester, binding, basePolicy);
    assert.equal(verified.state, "VERIFIED");
    assert.equal(verified.fundsAuthorized, false);
    const spoof = await evaluateTopicEmitterAtExactBlock(requester, binding, {
      ...basePolicy,
      allowedTokenRuntimeHashes: new Set([HASH_A.toLowerCase()]),
    });
    assert.equal(spoof.state, "PROFILE_MATCHED");
    assert.deepEqual(spoof.reasons, ["TOKEN_CODE_UNKNOWN"]);
  });
});

describe("identity, mechanism and strategy authorization", () => {
  it("treats name and symbol as candidates, not sufficient authorization", () => {
    const spoof = candidate({ creator: `0x${"9".repeat(40)}` });
    const evaluation = evaluateClockInIdentity(spoof, policy);
    assert.equal(evaluation.candidateMatch, true);
    assert.equal(evaluation.clockInBound, false);
    assert.deepEqual(evaluation.reasons, ["CREATOR_MISMATCH"]);
    assert.throws(
      () =>
        freezeLaunchIdentity({
          candidate: spoof,
          policy,
          tokenRuntimeCodeHash: HASH_A,
          poolRuntimeCodeHash: HASH_B,
          mechanismProfileId: "mechanism-1",
          configHash: "config-1",
          frozenAt: NOW,
        }),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "IDENTITY_INCOMPLETE",
    );
  });

  it("freezes canonical identity and reports official CA mismatch without replacement", () => {
    const frozen = freezeLaunchIdentity({
      candidate: candidate(),
      policy,
      tokenRuntimeCodeHash: HASH_A,
      poolRuntimeCodeHash: HASH_B,
      mechanismProfileId: "mechanism-1",
      configHash: "config-1",
      frozenAt: NOW,
    });
    assert.equal(reconcileOfficialCa(frozen, TOKEN), "CONFIRMED");
    assert.equal(reconcileOfficialCa(frozen, OTHER_TOKEN), "IDENTITY_CONFLICT");
    assert.equal(frozen.tokenAddress, TOKEN);
  });

  it("moves a removed identity into reconciliation and expires only unsent lanes on CA conflict", () => {
    const frozen = freezeLaunchIdentity({
      candidate: candidate(),
      policy,
      tokenRuntimeCodeHash: HASH_A,
      poolRuntimeCodeHash: HASH_B,
      mechanismProfileId: "mechanism-1",
      configHash: "config-1",
      frozenAt: NOW,
    });
    assert.equal(markIdentityForReorg(frozen).state, "REORG_RECONCILE");
    const lane = (laneId: string, state: WalletLane["state"]): WalletLane =>
      Object.freeze({
        laneId,
        strategyId: CLOCKIN_STRATEGY_ID,
        revision: 1,
        walletId: laneId,
        address: CREATOR,
        role: "CLOCKIN_ENTRY",
        trancheNumber: Number(laneId.at(-1)),
        maxPrincipalRaw: "5000000",
        evidenceIds: ["budget-1"],
        state,
        createdAt: NOW,
        updatedAt: NOW,
      });
    const conflict = applyOfficialCaGate(frozen, OTHER_TOKEN, [
      lane("lane-1", "FEE_ELIGIBLE"),
      lane("lane-2", "BROADCASTING"),
      lane("lane-3", "EFFECT_CONFIRMED"),
    ]);
    assert.equal(conflict.identity.tokenAddress, TOKEN);
    assert.equal(conflict.identity.state, "IDENTITY_CONFLICT");
    assert.equal(conflict.entryEnabled, false);
    assert.equal(conflict.exitEnabled, true);
    assert.deepEqual(
      conflict.laneStates.map((value) => value.state),
      ["EXPIRED", "BROADCASTING", "EFFECT_CONFIRMED"],
    );
  });

  it("implements HYBRID_CA_GATE and prevents AI authorization elevation", () => {
    assert.equal(
      authorizeEntryLane({
        strategyId: CLOCKIN_STRATEGY_ID,
        laneNumber: 1,
        identityLevel: "L2",
        gateMode: "HYBRID_CA_GATE",
        officialCaConfirmed: false,
        preapprovedStrongBinding: false,
        source: "DETERMINISTIC_POLICY",
        scope: AUTHORIZATION_SCOPE,
        riskEnvelope: AUTHORIZATION_RISK,
        issuedAt: NOW,
        expiresAt: "2026-08-16T00:02:00.000Z",
        maximumTtlMs: 604_800_000,
        evidenceIds: ["ev-1"],
      }).level,
      "L2",
    );
    assert.throws(
      () =>
        authorizeEntryLane({
          strategyId: CLOCKIN_STRATEGY_ID,
          laneNumber: 2,
          identityLevel: "L2",
          gateMode: "HYBRID_CA_GATE",
          officialCaConfirmed: false,
          preapprovedStrongBinding: false,
          source: "DETERMINISTIC_POLICY",
          scope: AUTHORIZATION_SCOPE,
          riskEnvelope: AUTHORIZATION_RISK,
          issuedAt: NOW,
          expiresAt: "2026-08-16T00:02:00.000Z",
          maximumTtlMs: 604_800_000,
          evidenceIds: ["ev-1"],
        }),
      /requires L3/,
    );
    assert.throws(
      () =>
        authorizeEntryLane({
          strategyId: CLOCKIN_STRATEGY_ID,
          laneNumber: 1,
          identityLevel: "L4",
          gateMode: "FACTORY_FULL",
          officialCaConfirmed: true,
          preapprovedStrongBinding: true,
          source: "AI_CANDIDATE",
          scope: { ...AUTHORIZATION_SCOPE, identityGate: "FACTORY_FULL" },
          riskEnvelope: AUTHORIZATION_RISK,
          issuedAt: NOW,
          expiresAt: "2026-08-16T00:02:00.000Z",
          maximumTtlMs: 604_800_000,
          evidenceIds: [],
        }),
      /AI candidate/,
    );
  });

  it("accepts exactly one week of pre-authorization and rejects one millisecond more", () => {
    const base = {
      strategyId: CLOCKIN_STRATEGY_ID,
      laneNumber: 1,
      identityLevel: "L2" as const,
      gateMode: "HYBRID_CA_GATE" as const,
      officialCaConfirmed: false,
      preapprovedStrongBinding: false,
      source: "DETERMINISTIC_POLICY" as const,
      scope: AUTHORIZATION_SCOPE,
      riskEnvelope: AUTHORIZATION_RISK,
      issuedAt: NOW,
      maximumTtlMs: 604_800_000,
      evidenceIds: ["owner-policy-v2"],
    };
    assert.equal(
      authorizeEntryLane({ ...base, expiresAt: "2026-08-23T00:00:00.000Z" }).mode,
      "AUTO_POLICY",
    );
    assert.throws(
      () => authorizeEntryLane({ ...base, expiresAt: "2026-08-23T00:00:00.001Z" }),
      /maximum TTL/,
    );
    assert.throws(
      () =>
        authorizeEntryLane({
          ...base,
          scope: { ...AUTHORIZATION_SCOPE, profileId: "" },
          expiresAt: "2026-08-23T00:00:00.000Z",
        }),
      /authorization scope must bind/,
    );
  });

  it("selects the 40%/2-minute profile and rejects the 99%/99-minute profile", () => {
    const clockIn = profileMechanism(mechanism());
    assert.equal(clockIn.kind, "CLOCKIN_40PCT_2MIN_V1");
    assert.doesNotThrow(() => assertClockInMechanism(clockIn));
    const safeLaunch = profileMechanism(mechanism(9_900, 5_940));
    assert.equal(safeLaunch.kind, "SAFE_LAUNCH_99PCT_99MIN");
    assert.throws(
      () => assertClockInMechanism(safeLaunch),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "PROFILE_UNSUPPORTED",
    );
  });

  it("reads every mechanism getter at one exact block and classifies invalid getter output", async () => {
    const expected = mechanism();
    const calls: bigint[] = [];
    const values: Record<string, unknown> = { ...expected };
    const reader = {
      evidenceId: "getter-evidence-1",
      async read(name: keyof typeof values, blockNumber: bigint): Promise<unknown> {
        calls.push(blockNumber);
        return values[name];
      },
    };
    const snapshot = await readMechanismSnapshot(reader, 123n);
    assert.equal(snapshot.initialFeeBps, 4_000);
    assert.equal(calls.length, 14);
    assert.ok(calls.every((block) => block === 123n));
    values.currentWindowCapRaw = "not-a-bigint";
    await assert.rejects(
      readMechanismSnapshot(reader, 123n),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "MECHANISM_GETTER_ERROR",
    );
    const reverting = {
      evidenceId: "getter-evidence-2",
      async read(): Promise<unknown> {
        throw new Error("execution reverted");
      },
    };
    await assert.rejects(
      readMechanismSnapshot(reverting, 123n),
      (error: unknown) =>
        error instanceof CanonicalInvariantError &&
        error.reasonCode === "MECHANISM_GETTER_ERROR" &&
        error.message.includes("reverted"),
    );
  });

  it("dedupes the first official launch to ClockIn and never lends its 50U budget", () => {
    const frozen = freezeLaunchIdentity({
      candidate: candidate(),
      policy,
      tokenRuntimeCodeHash: HASH_A,
      poolRuntimeCodeHash: HASH_B,
      mechanismProfileId: "mechanism-1",
      configHash: "config-1",
      frozenAt: NOW,
    });
    const router = new StrategyRouter({
      firstLaunchMode: "MONITOR_ONLY",
      firstLaunchBudgetUsdMicros: 0n,
    });
    const decision = router.route(frozen, true, true);
    assert.equal(decision.ownerStrategyId, CLOCKIN_STRATEGY_ID);
    assert.equal(decision.firstOfficialLaunch, "DEDUPED_TO_CLOCKIN");
    assert.match(decision.budgetId, /^clockin-mainnet-v1:/);
  });

  it("selects the first valid official launch by canonical chain order, not arrival order", () => {
    const later = freezeLaunchIdentity({
      candidate: candidate({
        candidateId: "later",
        blockNumber: "101",
        transactionHash: HASH_B,
      }),
      policy,
      tokenRuntimeCodeHash: HASH_A,
      poolRuntimeCodeHash: HASH_B,
      mechanismProfileId: "mechanism-1",
      configHash: "config-1",
      frozenAt: NOW,
    });
    const earlier = freezeLaunchIdentity({
      candidate: candidate({ candidateId: "earlier", blockNumber: "100" }),
      policy,
      tokenRuntimeCodeHash: HASH_A,
      poolRuntimeCodeHash: HASH_B,
      mechanismProfileId: "mechanism-1",
      configHash: "config-1",
      frozenAt: NOW,
    });
    const selected = selectCanonicalFirstOfficialLaunch([
      {
        identity: later,
        factoryVerified: true,
        creatorAuthorized: true,
        testLaunch: false,
        removed: false,
      },
      {
        identity: earlier,
        factoryVerified: true,
        creatorAuthorized: true,
        testLaunch: false,
        removed: false,
      },
      {
        identity: Object.freeze({ ...earlier, launchId: "stolen", blockNumber: "99" }),
        factoryVerified: true,
        creatorAuthorized: false,
        testLaunch: false,
        removed: false,
      },
    ]);
    assert.equal(selected?.candidateId, "earlier");
  });
});
