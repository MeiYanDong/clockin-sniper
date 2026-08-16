import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Interface, Wallet, ZeroAddress, keccak256 } from "ethers";

import { ConfiguredExitRouteRuntime } from "../src/adapters/configured-exit.js";
import { ConfiguredLauncherPoolRuntime } from "../src/adapters/configured-launcher.js";
import { CLOCKIN_POLICY_V2 } from "../src/config/strategy-config.js";
import type { LaunchIdentity, PositionLot } from "../src/core/canonical.js";
import {
  loadProductionProfileAndAuthorization,
  loadProductionWalletSigners,
} from "../src/runtime/credentials.js";
import {
  createProductionAuthorization,
  freezeProductionProfile,
  parseProductionAuthorization,
  parseProductionProfile,
  type ProductionProfileDraft,
} from "../src/runtime/production-profile.js";
import {
  assertExecutorDependenciesReady,
  emptyProductionServiceStatus,
  readProductionServiceStatus,
  writeProductionServiceStatus,
} from "../src/runtime/service-status.js";
import {
  parseProductionBroadcastSnapshot,
  snapshotEventKind,
} from "../src/runtime/transaction-snapshots.js";
import { SystemdWatchdog } from "../src/runtime/systemd-watchdog.js";
import type { WalletManifest } from "../src/wallets/wallet-manifest.js";

const HASH_A = `0x${"11".repeat(32)}` as const;
const HASH_B = `0x${"22".repeat(32)}` as const;
const REF_CODE = `0x${"33".repeat(32)}` as const;
const FACTORY = `0x${"44".repeat(20)}` as const;
const ROUTER = `0x${"55".repeat(20)}` as const;
const TOKEN = `0x${"66".repeat(20)}` as const;
const ROUTE_CODE = "0x6000" as const;
const ROUTE_CODE_HASH = keccak256(ROUTE_CODE) as `0x${string}`;
const LAUNCH_EVENT =
  "event TokenLaunched(address indexed creator,address indexed memeToken,address pool,string name,string symbol,string metadataURI,bytes32 imageHash)";
const LAUNCH_TOPIC = new Interface([LAUNCH_EVENT]).getEvent("TokenLaunched")?.topicHash;
if (LAUNCH_TOPIC === undefined) throw new Error("launch event fixture is invalid");

function fixtureWallets(): Readonly<{ manifest: WalletManifest; keys: readonly string[] }> {
  const signers = Array.from({ length: 10 }, (_, index) => {
    const key = `0x${String(index + 1).padStart(64, "0")}`;
    return new Wallet(key);
  });
  return Object.freeze({
    manifest: Object.freeze({
      revision: 1,
      generatedAt: "2026-08-16T00:00:00.000Z",
      entries: Object.freeze(
        signers.map((signer, index) =>
          Object.freeze({
            walletId: `entry-${String(index + 1).padStart(2, "0")}`,
            address: signer.address as `0x${string}`,
            role: "CLOCKIN_ENTRY" as const,
            expectedChainId: 4_663 as const,
          }),
        ),
      ),
    }),
    keys: Object.freeze(signers.map((signer) => signer.privateKey)),
  });
}

function fixtureProfile() {
  const draft: ProductionProfileDraft = Object.freeze({
    formatVersion: 1,
    profileId: "stonk-launcher-mainnet-v1",
    revision: 1,
    chainId: 4_663,
    adapterId: "clockin.configured-launcher-native-v1",
    factory: Object.freeze({
      address: FACTORY,
      runtimeCodeHash: HASH_A,
      startBlock: "100",
      launchEventAbi: LAUNCH_EVENT,
      launchEventTopic: LAUNCH_TOPIC as `0x${string}`,
      launchFields: Object.freeze({
        creator: "creator",
        token: "memeToken",
        pool: "pool",
        name: "name",
        symbol: "symbol",
        metadataUri: "metadataURI",
        imageHash: "imageHash",
      }),
    }),
    identity: Object.freeze({
      expectedName: "Clock In",
      expectedSymbol: "CLOCKIN",
      metadataIncludes: "clockin",
      officialCa: Object.freeze({
        url: "https://clockin.example/api/token",
        jsonKey: "contractAddress",
        pollMs: 1_000,
      }),
    }),
    mechanism: Object.freeze({
      profileId: "clockin-40pct-2min-v1",
      revision: 1,
      kind: "CLOCKIN_40PCT_2MIN_V1",
      maximumInitialFeeBps: 4_000,
      floorFeeBps: 0,
      decayWindowSeconds: 120,
      decayModel: "LINEAR_TIME",
      capScope: "PER_WALLET",
      cooldownScope: "PER_WALLET",
      quoteAsset: ZeroAddress as `0x${string}`,
      poolRuntimeCodeHashes: Object.freeze([ROUTE_CODE_HASH]),
      tokenRuntimeCodeHashes: Object.freeze([HASH_A]),
      functions: Object.freeze({
        currentFee: "function currentFeeBps() view returns (uint256)",
        inWindow: "function inSniperWindow() view returns (bool)",
        currentCap: "function currentWindowCap() view returns (uint256)",
        buyCooldown: "function buyCooldownSecs() view returns (uint256)",
        eoaOnly: "function eoaOnlySecs() view returns (uint256)",
        quoteAsset: "function quoteAsset() view returns (address)",
        previewBuy: "function previewBuy(uint256 principal) view returns (uint256)",
        buy: "function buy(uint256 minTokensOut,bytes32 refCode) payable returns (uint256)",
      }),
    }),
    entry: Object.freeze({
      refCode: REF_CODE,
      gasLimit: "400000",
      maximumFeePerGasWei: "2000000000",
      maximumPriorityFeePerGasWei: "1000000000",
      quoteMaximumAgeMs: 30_000,
      laterLaneMaximumDriftBps: 300,
      canaryMinimumOutputRaw: "1",
      maximumExecutionDriftBps: 500,
    }),
    exit: Object.freeze({
      routes: Object.freeze([
        Object.freeze({
          routeId: "launch-pool-v1",
          routeKind: "LAUNCH_POOL",
          adapterId: "configured-launch-pool-exit-v1",
          targetMode: "LAUNCH_POOL",
          runtimeCodeHash: ROUTE_CODE_HASH,
          quoteAsset: ZeroAddress as `0x${string}`,
          allowanceMode: "APPROVE",
          approvalSpenderMode: "ROUTE_TARGET",
          quoteCallLayout: "TOKEN_IN",
          quoteOutputKind: "EXECUTABLE_BEFORE_GAS",
          sellCallLayout: "TOKEN_IN_MIN_OUT_RECIPIENT",
          pathMode: "NONE",
          path: Object.freeze([]),
          quoteFunctionAbi: "function previewSell(uint256 tokenIn) view returns (uint256)",
          sellFunctionAbi: "function sell(uint256 tokenIn,uint256 minOut,address recipient)",
          approvalGasLimit: "100000",
          sellGasLimit: "800000",
          maximumFeePerGasWei: "2000000000",
          maximumPriorityFeePerGasWei: "1000000000",
          quoteMaximumAgeMs: 15000,
          evidenceIds: Object.freeze(["exit-route-evidence"]),
        }),
      ]),
    }),
    evidenceIds: Object.freeze(["official-source", "exact-block-code"]),
    createdAt: "2026-08-16T00:00:00.000Z",
  });
  return freezeProductionProfile(draft);
}

function fixtureIdentity(): LaunchIdentity {
  return Object.freeze({
    candidateId: "candidate-1",
    strategyId: "clockin-mainnet-v1",
    revision: 1,
    factoryProfileId: "stonk-launcher-mainnet-v1",
    creator: FACTORY,
    tokenAddress: TOKEN,
    poolAddress: ROUTER,
    name: "Clock In",
    symbol: "CLOCKIN",
    metadataUri: "https://clockin.example/metadata.json",
    imageHash: HASH_B,
    blockNumber: "100",
    blockHash: HASH_A,
    transactionHash: HASH_B,
    transactionIndex: "0",
    logIndex: "0",
    evidenceIds: Object.freeze(["factory-log"]),
    observedAt: "2026-08-17T00:00:00.000Z",
    launchId: "launch-1",
    tokenRuntimeCodeHash: HASH_A,
    poolRuntimeCodeHash: ROUTE_CODE_HASH,
    mechanismProfileId: "clockin-40pct-2min-v1",
    identityPolicyHash: "identity-policy-hash",
    configHash: CLOCKIN_POLICY_V2.configHash,
    frozenAt: "2026-08-17T00:00:00.000Z",
    state: "FROZEN",
  });
}

describe("production profile and seven-day authorization", () => {
  it("round-trips an immutable evidence-bound profile and detects any hash drift", () => {
    const profile = fixtureProfile();
    assert.deepEqual(parseProductionProfile(JSON.parse(JSON.stringify(profile))), profile);
    assert.throws(
      () => parseProductionProfile({ ...profile, entry: { ...profile.entry, gasLimit: "500000" } }),
      /hash mismatch/,
    );
    assert.throws(() => parseProductionProfile({ ...profile, exit: { routes: [] } }), /exit route/);
  });

  it("requires the exact owner-approved 4000-to-0 bps profile over 120 seconds", () => {
    const profile = fixtureProfile();
    const { profileHash: _profileHash, ...draft } = profile;
    const wrongFee = freezeProductionProfile({
      ...draft,
      mechanism: Object.freeze({ ...draft.mechanism, maximumInitialFeeBps: 3_999 }),
    });
    const wrongFloor = freezeProductionProfile({
      ...draft,
      mechanism: Object.freeze({ ...draft.mechanism, floorFeeBps: 1 }),
    });
    const wrongWindow = freezeProductionProfile({
      ...draft,
      mechanism: Object.freeze({ ...draft.mechanism, decayWindowSeconds: 119 }),
    });
    assert.throws(() => parseProductionProfile(wrongFee), /exact 4000 bps to 0 bps/);
    assert.throws(() => parseProductionProfile(wrongFloor), /exact 4000 bps to 0 bps/);
    assert.throws(() => parseProductionProfile(wrongWindow), /exact 120-second/);
  });

  it("binds exactly ten wallets, policy v2 and a maximum seven-day validity window", () => {
    const { manifest } = fixtureWallets();
    const profile = fixtureProfile();
    const issuedAt = "2026-08-16T00:00:00.000Z";
    const expiresAt = "2026-08-23T00:00:00.000Z";
    const authorization = createProductionAuthorization({
      authorizationId: "authorization-1",
      actorRef: "project-owner",
      profile,
      manifest,
      issuedAt,
      expiresAt,
      evidenceIds: ["owner-approval"],
      reason: "ClockIn production window",
    });
    assert.equal(authorization.strategyConfigHash, CLOCKIN_POLICY_V2.configHash);
    assert.equal(
      parseProductionAuthorization(authorization, profile, manifest, issuedAt).expiresAt,
      expiresAt,
    );
    assert.throws(
      () =>
        createProductionAuthorization({
          authorizationId: "authorization-too-long",
          actorRef: "project-owner",
          profile,
          manifest,
          issuedAt,
          expiresAt: "2026-08-23T00:00:00.001Z",
          evidenceIds: ["owner-approval"],
          reason: "invalid duration",
        }),
      /seven-day/,
    );
    assert.throws(
      () => parseProductionAuthorization(authorization, profile, manifest, expiresAt),
      /expired/,
    );
  });
});

describe("configured exact-block production exit route", () => {
  it("quotes native executable proceeds, subtracts gas and builds approve plus sell calldata", async () => {
    const profile = fixtureProfile();
    const route = profile.exit.routes[0];
    if (route === undefined) throw new Error("exit route fixture missing");
    const wallet = fixtureWallets().manifest.entries[0];
    if (wallet === undefined) throw new Error("wallet fixture missing");
    const lot: PositionLot = Object.freeze({
      lotId: "lot-1",
      strategyId: "clockin-mainnet-v1",
      revision: 1,
      launchId: "launch-1",
      laneId: "lane-1",
      walletAddress: wallet.address,
      tokenAddress: TOKEN,
      quantityRaw: "1000",
      remainingRaw: "1000",
      principalCostRaw: "1000000000000000",
      entryGasCostRaw: "10000000000000",
      buyFrictionRaw: Object.freeze({
        state: "UNKNOWN",
        reason: "fixture",
        since: "2026-08-17T00:00:00.000Z",
      }),
      entryRouteId: "entry-route",
      entryNonce: Object.freeze({
        state: "KNOWN",
        value: "0",
        observedAt: "2026-08-17T00:00:00.000Z",
        evidenceIds: Object.freeze(["entry-receipt"]),
      }),
      allowanceRaw: Object.freeze({
        state: "UNKNOWN",
        reason: "not read",
        since: "2026-08-17T00:00:00.000Z",
      }),
      pendingNonce: Object.freeze({
        state: "KNOWN",
        value: "1",
        observedAt: "2026-08-17T00:00:00.000Z",
        evidenceIds: Object.freeze(["nonce-read"]),
      }),
      declaredFeeBps: Object.freeze({
        state: "KNOWN",
        value: 4_000,
        observedAt: "2026-08-17T00:00:00.000Z",
        evidenceIds: Object.freeze(["fee-read"]),
      }),
      originEffectId: "entry-effect-1",
      state: "OPEN",
      evidenceIds: Object.freeze(["entry-effect-1"]),
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
    });
    const quoteAbi = new Interface([route.quoteFunctionAbi]);
    const allowanceAbi = new Interface([
      "function allowance(address owner,address spender) view returns (uint256)",
    ]);
    const approvalAbi = new Interface([
      "function approve(address spender,uint256 amount) returns (bool)",
    ]);
    const requester = {
      providerId: "fixture-rpc",
      async request<T>(method: string, params: readonly unknown[]): Promise<T> {
        if (method === "eth_getBlockByNumber") {
          return {
            number: "0x64",
            hash: HASH_A,
            timestamp: "0x66c13f00",
          } as T;
        }
        if (method === "eth_getCode") return ROUTE_CODE as T;
        if (method === "eth_call") {
          const request = params[0] as { readonly to: string; readonly data: string };
          if (request.to.toLowerCase() === TOKEN.toLowerCase()) {
            return allowanceAbi.encodeFunctionResult("allowance", [0n]) as T;
          }
          return quoteAbi.encodeFunctionResult("previewSell", [3_000_000_000_000_000n]) as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    assert.throws(
      () => new ConfiguredExitRouteRuntime({ requester, profile, route }),
      /requires a frozen launch identity/,
    );
    const runtime = new ConfiguredExitRouteRuntime({
      requester,
      profile,
      route,
      identity: fixtureIdentity(),
    });
    const result = await runtime.quoteLot(lot, 100n);
    assert.equal(result.approvalRequired, true);
    assert.equal(result.quote.grossOutputRaw, "3000000000000000");
    assert.equal(result.quote.approvalGasRaw, "200000000000000");
    assert.equal(result.quote.executionGasRaw, "1600000000000000");
    assert.equal(result.quote.netOutputRaw, "1200000000000000");
    const approval = runtime.buildApproval(TOKEN, 1_000n);
    assert.equal(approval.to, TOKEN);
    const decodedApproval = approvalAbi.decodeFunctionData("approve", approval.calldata);
    assert.equal(decodedApproval[0], ROUTER);
    assert.equal(decodedApproval[1], 1_000n);
    const sell = runtime.buildSell({
      lot,
      quote: result.quote,
      tokenInputRaw: 1_000n,
      minOutputRaw: 1_140_000_000_000_000n,
      deadlineTimestamp: 1_724_000_000n,
    });
    const decodedSell = new Interface([route.sellFunctionAbi]).decodeFunctionData(
      "sell",
      sell.calldata,
    );
    assert.equal(decodedSell[0], 1_000n);
    assert.equal(decodedSell[1], 1_140_000_000_000_000n);
    assert.equal(decodedSell[2], wallet.address);
  });

  it("fails closed when route bytecode drifts", async () => {
    const profile = fixtureProfile();
    const route = profile.exit.routes[0];
    if (route === undefined) throw new Error("exit route fixture missing");
    const runtime = new ConfiguredExitRouteRuntime({
      profile,
      route,
      identity: fixtureIdentity(),
      requester: {
        providerId: "drifted-rpc",
        async request<T>(method: string): Promise<T> {
          if (method === "eth_getCode") return "0x6001" as T;
          throw new Error(`unexpected method ${method}`);
        },
      },
    });
    await assert.rejects(runtime.verifyCodeIdentity(100n), /code hash drifted/);
  });
});

describe("configured exact-block production launcher", () => {
  it("binds only the frozen identity and builds the reviewed native buy call", async () => {
    const profile = fixtureProfile();
    const preview = new Interface([profile.mechanism.functions.previewBuy]);
    const buy = new Interface([profile.mechanism.functions.buy]);
    const runtime = new ConfiguredLauncherPoolRuntime({
      profile,
      identity: fixtureIdentity(),
      requester: {
        providerId: "launcher-fixture-rpc",
        async request<T>(method: string, params: readonly unknown[]): Promise<T> {
          assert.equal(method, "eth_call");
          const request = params[0] as { readonly to: string; readonly data: string };
          assert.equal(request.to, ROUTER);
          assert.equal(params[1], "0x64");
          assert.equal(preview.parseTransaction({ data: request.data })?.name, "previewBuy");
          return preview.encodeFunctionResult("previewBuy", [2_500n]) as T;
        },
      },
    });
    assert.equal(await runtime.previewBuyRaw(1_000n, 100n), 2_500n);
    const wallet = fixtureWallets().manifest.entries[0];
    if (wallet === undefined) throw new Error("wallet fixture missing");
    const template = runtime.buildNativeBuy({
      walletAddress: wallet.address,
      principalRaw: 1_000n,
      minOutputRaw: 2_000n,
      earliestValidBlock: 100n,
    });
    assert.equal(template.target, ROUTER);
    assert.equal(template.valueRaw, 1_000n);
    assert.equal(template.earliestValidBlock, 100n);
    const decoded = buy.decodeFunctionData("buy", template.calldata);
    assert.equal(decoded[0], 2_000n);
    assert.equal(decoded[1], REF_CODE);
  });

  it("rejects stale profile identity and non-allowlisted runtime code hashes", () => {
    const profile = fixtureProfile();
    const requester = {
      providerId: "unused-rpc",
      async request<T>(): Promise<T> {
        throw new Error("not called");
      },
    };
    assert.throws(
      () =>
        new ConfiguredLauncherPoolRuntime({
          profile,
          identity: Object.freeze({ ...fixtureIdentity(), factoryProfileId: "other-profile" }),
          requester,
        }),
      /identity and production profile differ/,
    );
    assert.throws(
      () =>
        new ConfiguredLauncherPoolRuntime({
          profile,
          identity: Object.freeze({ ...fixtureIdentity(), poolRuntimeCodeHash: HASH_B }),
          requester,
        }),
      /not allowlisted/,
    );
  });
});

describe("production pre-broadcast snapshot schema", () => {
  it("binds entry, approval and sell recovery payloads without accepting malformed amounts", () => {
    const entry = parseProductionBroadcastSnapshot({
      formatVersion: 1,
      kind: "ENTRY_BUY",
      validityExpiresAt: "2026-08-17T00:02:00.000Z",
      principalBalanceBeforeRaw: "10",
      tokenBalanceBeforeRaw: "0",
      plannedPrincipalRaw: "5",
      expectedTokenOutRaw: "7",
      quoteId: "quote-1",
      quoteBlock: "100",
      quoteBlockHash: HASH_A,
    });
    assert.equal(snapshotEventKind(entry), "ENTRY_PRE_BROADCAST_SNAPSHOT");
    const approval = parseProductionBroadcastSnapshot({
      formatVersion: 1,
      kind: "EXIT_APPROVAL",
      validityExpiresAt: "2026-08-17T00:03:00.000Z",
      lotId: "lot-1",
      routeId: "route-1",
      tokenAddress: TOKEN,
      spender: ROUTER,
      expectedAllowanceRaw: "1000",
    });
    assert.equal(snapshotEventKind(approval), "EXIT_APPROVAL_PRE_BROADCAST_SNAPSHOT");
    const sell = parseProductionBroadcastSnapshot({
      formatVersion: 1,
      kind: "EXIT_SELL",
      validityExpiresAt: "2026-08-17T00:03:00.000Z",
      exitPlanId: "exit-plan-1",
      lotId: "lot-1",
      routeQuoteId: "quote-2",
      quoteAsset: ZeroAddress,
      tokenBalanceBeforeRaw: "1000",
      quoteBalanceBeforeRaw: "10",
      expectedTokenInputRaw: "500",
      minimumQuoteOutputRaw: "1",
    });
    assert.equal(snapshotEventKind(sell), "EXIT_SELL_PRE_BROADCAST_SNAPSHOT");
    assert.throws(
      () =>
        parseProductionBroadcastSnapshot({
          ...sell,
          expectedTokenInputRaw: "1e18",
        }),
      /canonical non-negative integer/,
    );
  });
});

describe("systemd credential and redacted service status boundary", () => {
  it("loads ten signers by credential index and verifies profile authorization without logging keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clockin-credentials-"));
    const { manifest, keys } = fixtureWallets();
    const profile = fixtureProfile();
    const authorization = createProductionAuthorization({
      authorizationId: "authorization-credential-test",
      actorRef: "project-owner",
      profile,
      manifest,
      issuedAt: "2026-08-16T00:00:00.000Z",
      expiresAt: "2026-08-23T00:00:00.000Z",
      evidenceIds: ["owner-approval"],
      reason: "credential binding test",
    });
    await writeFile(join(directory, "wallet_manifest"), JSON.stringify(manifest), { mode: 0o600 });
    await writeFile(join(directory, "factory_profile"), JSON.stringify(profile), { mode: 0o600 });
    await writeFile(join(directory, "authorization"), JSON.stringify(authorization), {
      mode: 0o600,
    });
    await Promise.all(
      keys.map((key, index) =>
        writeFile(join(directory, `entry_${String(index + 1).padStart(2, "0")}`), key, {
          mode: 0o600,
        }),
      ),
    );
    const env = { CREDENTIALS_DIRECTORY: directory };
    const loaded = await loadProductionWalletSigners(env);
    assert.equal(loaded.signers.length, 10);
    assert.deepEqual(
      loaded.signers.map((item) => item.signer.address),
      manifest.entries.map((entry) => entry.address),
    );
    const bound = await loadProductionProfileAndAuthorization(
      loaded.manifest,
      env,
      "2026-08-16T00:00:00.000Z",
    );
    assert.equal(bound.profile.profileHash, profile.profileHash);
    assert.equal(bound.authorization.authorizationId, authorization.authorizationId);
  });

  it("writes atomic redacted status and reports stale or missing peers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clockin-status-"));
    await mkdir(directory, { recursive: true });
    const status = emptyProductionServiceStatus({
      service: "executor",
      state: "WATCHING",
      ownerId: "executor-a",
      sequence: 7,
      details: ["FACTORY_PROFILE_REQUIRED"],
      now: "2026-08-16T00:00:00.000Z",
    });
    await writeProductionServiceStatus(directory, status);
    assert.equal(
      (
        await readProductionServiceStatus(
          directory,
          "executor",
          10_000,
          Date.parse(status.observedAt),
        )
      ).state,
      "CURRENT",
    );
    assert.equal(
      (
        await readProductionServiceStatus(
          directory,
          "executor",
          10_000,
          Date.parse(status.observedAt) + 10_001,
        )
      ).state,
      "STALE",
    );
    assert.equal((await readProductionServiceStatus(directory, "exit", 10_000)).state, "MISSING");
    const raw = await readFile(join(directory, "executor-status.json"), "utf8");
    assert.doesNotMatch(raw, /private|credential|rawTransaction|0x0{63}1/i);
  });

  it("blocks executor dispatch unless reconciler and matching exit service are current", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clockin-dependencies-"));
    const now = "2026-08-17T00:00:00.000Z";
    const profile = fixtureProfile();
    const reconciler = Object.freeze({
      ...emptyProductionServiceStatus({
        service: "reconciler",
        state: "READY",
        ownerId: "reconciler-a",
        sequence: 1,
        now,
      }),
      database: Object.freeze({ schemaVersion: 5, walEnabled: true, leaseOwned: true }),
      exitEnabled: true,
    });
    const exit = Object.freeze({
      ...emptyProductionServiceStatus({
        service: "exit",
        state: "READY",
        ownerId: "exit-a",
        sequence: 1,
        now,
      }),
      profileHash: profile.profileHash,
      authorizationId: "authorization-a",
      signerReady: 10,
      database: Object.freeze({ schemaVersion: 5, walEnabled: true, leaseOwned: true }),
      exitEnabled: true,
    });
    await writeProductionServiceStatus(directory, reconciler);
    await writeProductionServiceStatus(directory, exit);
    await assertExecutorDependenciesReady({
      directory,
      profileHash: profile.profileHash,
      authorizationId: "authorization-a",
      expectedSignerCount: 10,
      nowMs: Date.parse(now),
    });
    await writeProductionServiceStatus(directory, {
      ...exit,
      sequence: 2,
      state: "DEGRADED",
    });
    await assert.rejects(
      assertExecutorDependenciesReady({
        directory,
        profileHash: profile.profileHash,
        authorizationId: "authorization-a",
        expectedSignerCount: 10,
        nowMs: Date.parse(now),
      }),
      /exit service is not ready/,
    );
  });

  it("notifies readiness, emits watchdog heartbeats and stops cleanly under systemd", async () => {
    const calls: string[][] = [];
    const watchdog = new SystemdWatchdog(
      { NOTIFY_SOCKET: "/run/systemd/notify", WATCHDOG_USEC: "500000" },
      async (args) => {
        calls.push([...args]);
      },
    );
    await watchdog.ready("executor ready");
    await new Promise((resolve) => setTimeout(resolve, 275));
    await watchdog.stopping("executor stopping");
    assert.equal(
      calls.some((args) => args.includes("--ready")),
      true,
    );
    assert.equal(
      calls.some((args) => args.includes("--watchdog")),
      true,
    );
    assert.equal(
      calls.some((args) => args.includes("--stopping")),
      true,
    );
  });
});
