import { hostname } from "node:os";

import { keccak256 } from "ethers";

import {
  ConfiguredLauncherPoolRuntime,
  verifyConfiguredCodeIdentity,
} from "./adapters/configured-launcher.js";
import { SameRawBroadcaster } from "./broadcast/same-raw-broadcaster.js";
import { CLOCKIN_POLICY_V2 } from "./config/strategy-config.js";
import {
  stableHash,
  type CapitalReservation,
  type ExecutionPlan,
  type LaunchIdentity,
  type TxAttempt,
  type WalletLane,
} from "./core/canonical.js";
import { freezeQuoteBoundedEntryPlan } from "./entry/execution-plan-builder.js";
import { planTenFeeBands, type FeeBandPlan } from "./entry/fee-band-planner.js";
import { TenLaneOrchestrator, type LaneDispatchDecision } from "./entry/lane-orchestrator.js";
import { createQuoteSnapshot, quoteBoundedMinOut } from "./entry/quote-policy.js";
import { freezeLaunchIdentity, type ClockInIdentityPolicy } from "./identity/identity-binder.js";
import { OfficialCaMonitor } from "./official-ca-monitor.js";
import { SqliteStore } from "./persistence/sqlite-store.js";
import { HttpJsonRpcClient } from "./rpc/http-json-rpc.js";
import { WebSocketNewHeadsClient, type NewHeadsSubscription } from "./rpc/websocket-new-heads.js";
import type { Hex } from "./rpc/types.js";
import { discoverConfiguredClockInLaunch } from "./runtime/configured-discovery.js";
import {
  loadProductionProfileAndAuthorization,
  loadProductionWalletSigners,
  loadVaultKey,
  readSystemdCredential,
} from "./runtime/credentials.js";
import { ProductionPriceCache } from "./runtime/production-price.js";
import {
  ProductionSameRawProvider,
  readGenesisHash,
  readNativeBalance,
  readTokenBalance,
} from "./runtime/production-rpc.js";
import type { ProductionProtocolProfile } from "./runtime/production-profile.js";
import {
  assertExecutorDependenciesReady,
  writeProductionServiceStatus,
} from "./runtime/service-status.js";
import { SystemdWatchdog } from "./runtime/systemd-watchdog.js";
import { SignedTxVault } from "./wallets/signed-tx-vault.js";
import { WalletTransactionCoordinator, type NonceSlot } from "./wallets/transaction-coordinator.js";
import { inspectWalletReadiness, type WalletReadinessReport } from "./wallets/readiness.js";

const STRATEGY_ID = "clockin-mainnet-v1";
const STATUS_DIRECTORY = process.env.CLOCKIN_STATUS_DIR?.trim() || "/run/clockin-status";
const STATE_DIRECTORY = process.env.CLOCKIN_STATE_DIR?.trim() || "/var/lib/clockin-sniper";
const LEASE_TTL_MS = 30_000;

interface LeaseBinding {
  readonly walletAddress: `0x${string}`;
  readonly epoch: number;
  active: boolean;
}

interface LaunchRuntime {
  readonly identity: LaunchIdentity;
  readonly pool: ConfiguredLauncherPoolRuntime;
  readonly feePlan: FeeBandPlan;
  readonly orchestrator: TenLaneOrchestrator;
  readonly priceBatchWei: bigint;
  readonly canaryExpectedOutputRaw: bigint;
  readonly canaryQuoteId: string;
  readonly officialCa: OfficialCaMonitor;
  readonly expiresAtMs: number;
  canaryApplied: boolean;
}

class ProvenPreBroadcastFailure extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ProvenPreBroadcastFailure";
  }
}

function reviseEntryPlan(
  plan: ExecutionPlan,
  state: Extract<ExecutionPlan["state"], "SIGNED" | "INVALIDATED">,
): ExecutionPlan {
  return Object.freeze({ ...plan, revision: plan.revision + 1, state });
}

function log(kind: "INFO" | "ACTION" | "ERROR", message: string, details: object = {}): void {
  process.stdout.write(
    `${JSON.stringify({ service: "clockin-executor", kind, message, ...details })}\n`,
  );
}

function expiry(nowMs: number, ttlMs: number): string {
  return new Date(nowMs + ttlMs).toISOString();
}

function identityPolicy(profile: ProductionProtocolProfile): ClockInIdentityPolicy {
  return Object.freeze({
    expectedNames: Object.freeze([profile.identity.expectedName]),
    expectedSymbols: Object.freeze([profile.identity.expectedSymbol]),
    expectedCreators: Object.freeze(
      profile.identity.expectedCreator === undefined ? [] : [profile.identity.expectedCreator],
    ),
    metadataIncludes: Object.freeze(
      profile.identity.metadataIncludes === undefined ? [] : [profile.identity.metadataIncludes],
    ),
    tokenSuffixes: Object.freeze(
      profile.identity.requiredTokenSuffix === undefined
        ? []
        : [profile.identity.requiredTokenSuffix],
    ),
    requireCreator: profile.identity.expectedCreator !== undefined,
    requireMetadata: profile.identity.metadataIncludes !== undefined,
    requireTokenSuffix: profile.identity.requiredTokenSuffix !== undefined,
    policyRevision: profile.revision,
  });
}

function transportState(state: "ACCEPTED" | "KNOWN" | "UNKNOWN" | "REJECTED"): TxAttempt["state"] {
  if (state === "ACCEPTED" || state === "KNOWN") return "ACCEPTED";
  return state === "UNKNOWN" ? "UNKNOWN" : "DROPPED_PROVEN";
}

async function main(): Promise<void> {
  const ownerId = process.env.CLOCKIN_EXECUTOR_ID?.trim() || `clockin-executor:${hostname()}`;
  const watchdog = new SystemdWatchdog();
  const shutdown = new AbortController();
  let stopping = false;
  let sequence = 0;
  let currentLaunch: LaunchRuntime | null = null;
  let headsSubscription: NewHeadsSubscription | null = null;
  let leaseTimer: NodeJS.Timeout | null = null;
  let statusTimer: NodeJS.Timeout | null = null;
  let priceTimer: NodeJS.Timeout | null = null;

  const [walletBundle, rpcHttp, rpcWss, sequencerHttp, vaultKey] = await Promise.all([
    loadProductionWalletSigners(),
    readSystemdCredential("rpc_http"),
    readSystemdCredential("rpc_wss"),
    readSystemdCredential("sequencer_http"),
    loadVaultKey(),
  ]);
  const { profile, authorization } = await loadProductionProfileAndAuthorization(
    walletBundle.manifest,
  );
  const canonical = new HttpJsonRpcClient({
    providerId: "production-http",
    url: rpcHttp,
    timeoutMs: 4_000,
  });
  const sequencer = new HttpJsonRpcClient({
    providerId: "official-sequencer",
    url: sequencerHttp,
    timeoutMs: 2_000,
  });
  const store = new SqliteStore(`${STATE_DIRECTORY}/canonical.sqlite`);
  const vault = new SignedTxVault(`${STATE_DIRECTORY}/vault`, vaultKey);
  const coordinator = new WalletTransactionCoordinator(store);
  const priceCache = new ProductionPriceCache();

  const writeStatus = async (
    state: "BOOTING" | "WATCHING" | "READY" | "ACTIVE" | "DEGRADED" | "STOPPING" | "FAILED",
    details: readonly string[] = [],
  ): Promise<void> => {
    sequence += 1;
    const now = new Date().toISOString();
    const activeLeases = leases.filter((binding) => binding.active);
    const leasesOwned =
      activeLeases.length > 0 &&
      activeLeases.every((binding) =>
        store.ownsServiceLease(
          `wallet:${binding.walletAddress.toLowerCase()}`,
          ownerId,
          binding.epoch,
          now,
        ),
      );
    await writeProductionServiceStatus(STATUS_DIRECTORY, {
      formatVersion: 1,
      service: "executor",
      state,
      pid: process.pid,
      ownerId,
      sequence,
      observedAt: now,
      profileId: profile.profileId,
      profileRevision: profile.revision,
      profileHash: profile.profileHash,
      authorizationId: authorization.authorizationId,
      authorizationExpiresAt: authorization.expiresAt,
      signerReady: walletBundle.signers.length,
      database: Object.freeze({
        schemaVersion: store.schemaVersion(),
        walEnabled: store.walEnabled(),
        leaseOwned: leasesOwned,
      }),
      entryEnabled:
        !stopping &&
        Date.now() < Date.parse(authorization.expiresAt) &&
        (currentLaunch === null || Date.now() <= currentLaunch.expiresAtMs) &&
        activeLeases.length > 0,
      exitEnabled: true,
      unresolvedAttemptCount: store.unresolvedTxAttempts(STRATEGY_ID).length,
      openPositionCount: store.latestOpenPositionLots(STRATEGY_ID).length,
      verifiedExitRouteCount: profile.exit.routes.length,
      details: Object.freeze([...details, `ACTIVE_WALLET_LEASES_${activeLeases.length}`]),
    });
  };

  const price = await priceCache.refresh();
  await verifyConfiguredCodeIdentity({ requester: canonical, profile, blockNumber: "latest" });
  const genesisHash = await readGenesisHash(canonical);
  const broadcaster = new SameRawBroadcaster({
    providers: Object.freeze([
      new ProductionSameRawProvider({
        requester: canonical,
        region: process.env.CLOCKIN_REGION?.trim() || "active-region",
        mode: "STANDARD",
        expectedGenesisHash: genesisHash,
      }),
      new ProductionSameRawProvider({
        requester: sequencer,
        region: "robinhood-sequencer",
        mode: "OFFICIAL_SEQUENCER",
        expectedGenesisHash: genesisHash,
      }),
    ]),
    expectedChainId: 4_663,
    expectedGenesisHash: genesisHash,
  });
  await broadcaster.preflight();
  const assertDependencies = (): Promise<void> =>
    assertExecutorDependenciesReady({
      directory: STATUS_DIRECTORY,
      profileHash: profile.profileHash,
      authorizationId: authorization.authorizationId,
      expectedSignerCount: walletBundle.signers.length,
    });
  await assertDependencies();

  const maximumExitGas = profile.exit.routes.reduce(
    (maximum, route) => {
      const approval = BigInt(route.approvalGasLimit);
      const sell = BigInt(route.sellGasLimit);
      const fee = BigInt(route.maximumFeePerGasWei);
      return {
        approval: approval > maximum.approval ? approval : maximum.approval,
        sell: sell > maximum.sell ? sell : maximum.sell,
        fee: fee > maximum.fee ? fee : maximum.fee,
      };
    },
    { approval: 1n, sell: 1n, fee: 1n },
  );
  const aggregateAllInCapWei =
    (CLOCKIN_POLICY_V2.allInRiskCapUsdMicros * 1_000_000_000_000_000_000n) /
    price.primary.usdMicrosPerEth;
  let readiness: WalletReadinessReport = await inspectWalletReadiness(
    canonical,
    walletBundle.manifest,
    {
      batchValueWei: price.batchValueWei,
      entryGasLimit: BigInt(profile.entry.gasLimit),
      entryMaxFeePerGasWei: BigInt(profile.entry.maximumFeePerGasWei),
      approvalGasLimit: maximumExitGas.approval,
      sellGasLimit: maximumExitGas.sell,
      exitMaxFeePerGasWei: maximumExitGas.fee,
      maximumSellTransactions: CLOCKIN_POLICY_V2.maximumSellTransactionsPerWallet,
      gasSafetyMarginBps: CLOCKIN_POLICY_V2.gasSafetyMarginBps,
      aggregateAllInCapWei,
      automaticTopUpAllowed: false,
    },
  );
  if (!readiness.hotArmed)
    throw new Error("ten-wallet funding or nonce readiness is not HOT_ARMED");
  if (store.unresolvedTxAttempts(STRATEGY_ID).length > 0) {
    throw new Error("unresolved transaction attempts block new entry on executor startup");
  }
  for (const entry of walletBundle.manifest.entries) {
    if (store.walletHasUnresolvedNonce(entry.address)) {
      throw new Error(`wallet ${entry.walletId} has unresolved persistent nonce ownership`);
    }
  }

  const leases: LeaseBinding[] = [];
  for (const row of readiness.rows) {
    const now = new Date().toISOString();
    const epoch = coordinator.acquire(
      row.address,
      ownerId,
      row.latestNonce,
      row.pendingNonce,
      now,
      expiry(Date.parse(now), LEASE_TTL_MS),
    );
    leases.push({ walletAddress: row.address, epoch, active: true });
  }

  const releaseEligibleLeases = (windowExpired: boolean): void => {
    const attempts = store.latestTxAttempts(STRATEGY_ID);
    const attemptedWallets = new Set(
      attempts.map((attempt) => attempt.walletAddress.toLowerCase()),
    );
    for (const binding of leases) {
      if (!binding.active || store.walletHasUnresolvedNonce(binding.walletAddress)) continue;
      if (!windowExpired && !attemptedWallets.has(binding.walletAddress.toLowerCase())) continue;
      store.releaseServiceLease(
        `wallet:${binding.walletAddress.toLowerCase()}`,
        ownerId,
        binding.epoch,
        new Date().toISOString(),
      );
      binding.active = false;
    }
  };

  const renewLeases = (): void => {
    const now = new Date().toISOString();
    const expiresAt = expiry(Date.parse(now), LEASE_TTL_MS);
    for (const binding of leases) {
      if (!binding.active) continue;
      store.renewServiceLease(
        `wallet:${binding.walletAddress.toLowerCase()}`,
        ownerId,
        binding.epoch,
        expiresAt,
        now,
      );
    }
  };
  leaseTimer = setInterval(() => {
    try {
      releaseEligibleLeases(currentLaunch !== null && Date.now() > currentLaunch.expiresAtMs);
      renewLeases();
    } catch (error) {
      log("ERROR", "wallet lease renewal failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      shutdown.abort();
    }
  }, 10_000);
  leaseTimer.unref();
  priceTimer = setInterval(() => {
    void priceCache.refresh().catch((error: unknown) =>
      log("ERROR", "price refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }, 10_000);
  priceTimer.unref();
  statusTimer = setInterval(() => {
    void writeStatus(currentLaunch === null ? "WATCHING" : "ACTIVE").catch(() => undefined);
  }, 5_000);
  statusTimer.unref();
  await writeStatus("WATCHING", ["EXACT_FACTORY_SUBSCRIPTION_STARTING"]);
  await watchdog.ready("executor verified and watching exact Factory");

  const signerByWalletId = new Map(
    walletBundle.signers.map((item) => [item.entry.walletId, item] as const),
  );
  let readinessByWalletId = new Map(readiness.rows.map((row) => [row.walletId, row] as const));
  const leaseByAddress = new Map(
    leases.map((binding) => [binding.walletAddress.toLowerCase(), binding] as const),
  );

  const dispatchLane = async (
    runtime: LaunchRuntime,
    decision: LaneDispatchDecision,
    blockHash: `0x${string}`,
    blockNumber: bigint,
    expectedTokenOutRaw: bigint,
  ): Promise<void> => {
    if (Date.now() >= Date.parse(authorization.expiresAt)) throw new Error("authorization expired");
    let reservation: CapitalReservation | null = null;
    let slot: NonceSlot | null = null;
    let plan: ExecutionPlan | null = null;
    let attempt: TxAttempt | null = null;
    let vaultRef: string | null = null;
    let possiblySubmitted = false;
    let signerAddress: `0x${string}` | null = null;
    try {
      await assertDependencies();
      const signerBinding = signerByWalletId.get(decision.walletId);
      const walletReadiness = readinessByWalletId.get(decision.walletId);
      if (signerBinding === undefined || walletReadiness === undefined) {
        throw new Error(`lane ${decision.laneId} has no signer/readiness binding`);
      }
      signerAddress = signerBinding.entry.address;
      const lease = leaseByAddress.get(signerBinding.entry.address.toLowerCase());
      if (lease === undefined || !lease.active) throw new Error("wallet lease binding is inactive");
      const now = new Date().toISOString();
      const intentId = `entry-intent:${stableHash({
        launchId: runtime.identity.launchId,
        laneId: decision.laneId,
        wallet: signerBinding.entry.address,
      })}`;
      const planId = `entry-plan:${stableHash({ intentId, nonce: walletReadiness.pendingNonce.toString() })}`;
      coordinator.claimEntryIntent({
        strategyId: STRATEGY_ID,
        launchId: runtime.identity.launchId,
        walletAddress: signerBinding.entry.address,
        intentId,
        createdAt: now,
      });
      const principalUsdMicros =
        (CLOCKIN_POLICY_V2.nominalLaneUsdMicros * decision.principalRaw) / runtime.priceBatchWei;
      reservation = Object.freeze({
        reservationId:
          runtime.feePlan.lanes[decision.trancheNumber - 1]?.reservationId ??
          `${intentId}:reservation`,
        strategyId: STRATEGY_ID,
        revision: 1,
        budgetId: `${runtime.identity.launchId}:budget`,
        launchId: runtime.identity.launchId,
        laneId: decision.laneId,
        intentId,
        configHash: CLOCKIN_POLICY_V2.configHash,
        principalRaw: principalUsdMicros.toString(),
        state: "RESERVED",
        evidenceIds: Object.freeze([authorization.authorizationId, decision.observationId]),
        createdAt: now,
        updatedAt: now,
      });
      slot = coordinator.reserveWithCapital(
        reservation,
        signerBinding.entry.address,
        ownerId,
        lease.epoch,
        walletReadiness.pendingNonce,
        "ENTRY",
        planId,
        now,
      );
      const quote = createQuoteSnapshot({
        laneId: decision.laneId,
        poolObservationId: decision.observationId,
        profileRevision: profile.mechanism.revision,
        blockNumber,
        blockHash,
        principalRaw: decision.principalRaw,
        expectedTokenOutRaw,
        observedAtMs: Date.now(),
        expiresAtMs: Date.now() + profile.entry.quoteMaximumAgeMs,
        evidenceIds: Object.freeze([decision.observationId]),
      });
      const minOutputRaw =
        decision.trancheNumber === 1
          ? BigInt(profile.entry.canaryMinimumOutputRaw)
          : quoteBoundedMinOut(
              quote,
              profile.entry.laterLaneMaximumDriftBps,
              Date.now(),
              blockHash,
            );
      const template = runtime.pool.buildNativeBuy({
        walletAddress: signerBinding.entry.address,
        principalRaw: decision.principalRaw,
        minOutputRaw,
        earliestValidBlock: BigInt(runtime.identity.blockNumber),
      });
      if (blockNumber < template.earliestValidBlock) {
        throw new Error("entry template is not yet valid at the observed block");
      }
      const draft = {
        planId,
        strategyId: STRATEGY_ID,
        revision: 1,
        intentId,
        launchId: runtime.identity.launchId,
        laneId: decision.laneId,
        validityEnvelopeId: `validity:${runtime.identity.launchId}`,
        authorizationId: authorization.authorizationId,
        factoryProfileRevision: profile.revision,
        mechanismProfileRevision: profile.mechanism.revision,
        adapterId: template.adapterId,
        walletAddress: signerBinding.entry.address,
        nonce: walletReadiness.pendingNonce.toString(),
        to: template.target,
        valueRaw: template.valueRaw.toString(),
        calldataHash: keccak256(template.calldata),
        methodSelector: template.calldata.slice(0, 10) as `0x${string}`,
        observedFeeBps: decision.observedFeeBps,
        targetFeeBps: decision.targetFeeBps,
        gasLimit: profile.entry.gasLimit,
        maxFeePerGasRaw: profile.entry.maximumFeePerGasWei,
        maxPriorityFeePerGasRaw: profile.entry.maximumPriorityFeePerGasWei,
        capitalReservationId: reservation.reservationId,
        evidenceIds: Object.freeze([
          ...runtime.identity.evidenceIds,
          quote.quoteId,
          authorization.authorizationId,
        ]),
        createdAt: now,
      } satisfies Omit<ExecutionPlan, "planHash" | "state" | "quoteBlock" | "minOutputRaw">;
      plan = freezeQuoteBoundedEntryPlan({ draft, quote, minOutputRaw });
      store.saveExecutionPlan(plan);
      const [principalBefore, tokenBefore] = await Promise.all([
        readNativeBalance(canonical, signerBinding.entry.address, "latest"),
        readTokenBalance(
          canonical,
          runtime.identity.tokenAddress,
          signerBinding.entry.address,
          "latest",
        ),
      ]);
      if (walletReadiness.pendingNonce > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError("wallet nonce cannot be represented by the signer transaction API");
      }
      const raw = (await signerBinding.signer.signTransaction({
        chainId: 4_663,
        type: 2,
        nonce: Number(walletReadiness.pendingNonce),
        to: template.target,
        value: template.valueRaw,
        data: template.calldata,
        gasLimit: BigInt(profile.entry.gasLimit),
        maxFeePerGas: BigInt(profile.entry.maximumFeePerGasWei),
        maxPriorityFeePerGas: BigInt(profile.entry.maximumPriorityFeePerGasWei),
      })) as `0x${string}`;
      const txHash = keccak256(raw) as Hex;
      vaultRef = await vault.put(raw, now);
      slot = coordinator.transition(slot, "SIGNED", now);
      plan = reviseEntryPlan(plan, "SIGNED");
      store.saveExecutionPlan(plan);
      const attemptId = `tx-attempt:${stableHash({ planId, txHash })}`;
      attempt = Object.freeze({
        attemptId,
        strategyId: STRATEGY_ID,
        revision: 1,
        intentId,
        planId,
        launchId: runtime.identity.launchId,
        laneId: decision.laneId,
        walletAddress: signerBinding.entry.address,
        nonce: walletReadiness.pendingNonce.toString(),
        operation: "INITIAL",
        signedTxHash: txHash,
        payloadHash: `keccak256:${txHash.slice(2)}`,
        vaultRef,
        transportEvents: Object.freeze([]),
        state: "SIGNED",
        evidenceIds: Object.freeze([plan.planHash, authorization.authorizationId]),
        createdAt: now,
        updatedAt: now,
      });
      store.saveTxAttempt(attempt);
      store.appendAuditEvent({
        eventId: `pre-broadcast:${attemptId}`,
        eventKind: "ENTRY_PRE_BROADCAST_SNAPSHOT",
        strategyId: STRATEGY_ID,
        launchId: runtime.identity.launchId,
        objectId: attemptId,
        payload: {
          formatVersion: 1,
          kind: "ENTRY_BUY",
          principalBalanceBeforeRaw: principalBefore.toString(),
          tokenBalanceBeforeRaw: tokenBefore.toString(),
          plannedPrincipalRaw: decision.principalRaw.toString(),
          expectedTokenOutRaw: expectedTokenOutRaw.toString(),
          validityExpiresAt: new Date(runtime.expiresAtMs).toISOString(),
          quoteId: quote.quoteId,
          quoteBlock: quote.blockNumber.toString(),
          quoteBlockHash: quote.blockHash,
        },
        observedAt: now,
      });
      slot = coordinator.transition(slot, "POSSIBLY_SUBMITTED", now);
      possiblySubmitted = true;
      const result = await broadcaster.broadcast(raw);
      const updatedAt = new Date().toISOString();
      const nextState = transportState(result.state);
      attempt = Object.freeze({
        ...attempt,
        revision: attempt.revision + 1,
        state: nextState,
        transportEvents: Object.freeze(
          result.outcomes.map((outcome, index) =>
            Object.freeze({
              routeId: outcome.providerId,
              startedAt: now,
              completedAt: updatedAt,
              result:
                outcome.result === "ACCEPTED"
                  ? "ACCEPTED"
                  : outcome.result === "KNOWN"
                    ? "KNOWN"
                    : outcome.result === "REJECTED"
                      ? "REJECTED"
                      : "ERROR",
              latencyMs: outcome.latencyMs,
              evidenceId: `transport:${attemptId}:${index + 1}`,
            }),
          ),
        ),
        updatedAt,
      });
      store.saveTxAttempt(attempt);
      if (nextState === "UNKNOWN") {
        slot = coordinator.transition(slot, "UNKNOWN", updatedAt);
      } else if (nextState === "DROPPED_PROVEN") {
        slot = coordinator.releaseAfterDeterministicRejection(
          slot,
          {
            allRoutesRejected: true,
            signedHashUnchanged: result.txHash.toLowerCase() === txHash.toLowerCase(),
          },
          updatedAt,
        );
        store.updateReservationState(reservation.reservationId, "RELEASED", updatedAt);
        plan = reviseEntryPlan(plan, "INVALIDATED");
        store.saveExecutionPlan(plan);
        await vault.remove(vaultRef).catch((error: unknown) =>
          log("ERROR", "deterministically rejected payload cleanup failed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      log("ACTION", "lane broadcast completed", {
        laneId: decision.laneId,
        trancheNumber: decision.trancheNumber,
        txHash,
        transportState: result.state,
        observedFeeBps: decision.observedFeeBps,
        principalWei: decision.principalRaw.toString(),
      });
    } catch (error) {
      const updatedAt = new Date().toISOString();
      if (!possiblySubmitted) {
        if (slot !== null) {
          try {
            coordinator.transition(slot, "RELEASED", updatedAt);
          } catch {
            // Persisted ownership remains fail-closed if deterministic cleanup cannot be proven.
          }
        }
        if (reservation !== null) {
          try {
            store.updateReservationState(reservation.reservationId, "RELEASED", updatedAt);
          } catch {
            // The reservation may not have reached durable storage.
          }
        }
        if (plan !== null && plan.state !== "INVALIDATED") {
          try {
            store.saveExecutionPlan(reviseEntryPlan(plan, "INVALIDATED"));
          } catch {
            // The original pre-broadcast failure remains primary.
          }
        }
        if (attempt !== null && attempt.state !== "DROPPED_PROVEN") {
          try {
            store.saveTxAttempt(
              Object.freeze({
                ...attempt,
                revision: attempt.revision + 1,
                state: "DROPPED_PROVEN",
                updatedAt,
              }),
            );
          } catch {
            // The nonce slot and vault cleanup remain the primary no-broadcast proof.
          }
        }
        if (vaultRef !== null) await vault.remove(vaultRef).catch(() => undefined);
        throw new ProvenPreBroadcastFailure(
          error instanceof Error ? error.message : String(error),
          error,
        );
      }
      if (slot !== null) {
        try {
          coordinator.transition(slot, "UNKNOWN", updatedAt);
        } catch {
          // Possibly submitted ownership must remain fenced even if status revision fails.
        }
      }
      if (attempt !== null && attempt.state !== "UNKNOWN") {
        try {
          store.saveTxAttempt(
            Object.freeze({
              ...attempt,
              revision: attempt.revision + 1,
              state: "UNKNOWN",
              updatedAt,
            }),
          );
        } catch {
          // The signed payload remains in the vault for startup recovery.
        }
      }
      if (signerAddress !== null) {
        log("ERROR", "possibly submitted entry retained for reconciliation", {
          walletAddress: signerAddress,
        });
      }
      throw error;
    }
  };

  const processHead = async (runtime: LaunchRuntime, blockNumber: bigint): Promise<void> => {
    if (stopping || blockNumber < BigInt(runtime.identity.blockNumber)) return;
    if (Date.now() > runtime.expiresAtMs) {
      releaseEligibleLeases(true);
      return;
    }
    if (!runtime.canaryApplied) {
      const canaryEffect = store
        .latestEffectRecords(STRATEGY_ID, runtime.identity.launchId)
        .find((effect) => effect.laneId === "clockin-entry-01");
      if (canaryEffect !== undefined) {
        const actual =
          canaryEffect.actualOutputRaw.state === "KNOWN"
            ? BigInt(canaryEffect.actualOutputRaw.value)
            : 0n;
        const minimum =
          (runtime.canaryExpectedOutputRaw *
            BigInt(10_000 - profile.entry.maximumExecutionDriftBps)) /
          10_000n;
        const calibrated = canaryEffect.result === "SUCCESS" && actual >= minimum;
        runtime.orchestrator.applyCanaryCalibration(!calibrated);
        runtime.canaryApplied = true;
        log(
          calibrated ? "INFO" : "ERROR",
          calibrated ? "canary calibrated" : "canary stopped unsent lanes",
          {
            effectId: canaryEffect.effectId,
            result: canaryEffect.result,
          },
        );
      }
    }
    const observation = await runtime.pool.observe(blockNumber, [
      `head:${blockNumber}`,
      `profile:${profile.profileHash}`,
    ]);
    if (observation.quoteAsset.toLowerCase() !== profile.mechanism.quoteAsset.toLowerCase()) {
      throw new Error("observed pool quote asset differs from the production profile");
    }
    const caState = runtime.officialCa.snapshot().state;
    if (caState === "mismatch") runtime.orchestrator.applyCanaryCalibration(true);
    const identityLevel =
      caState === "confirmed" && runtime.canaryApplied ? ("L3" as const) : ("L2" as const);
    const quotes = new Map<string, ReturnType<typeof createQuoteSnapshot>>();
    for (const lane of runtime.orchestrator.snapshot()) {
      if (
        lane.trancheNumber === 1 ||
        lane.state === "DISPATCHED" ||
        lane.state === "EFFECT_CONFIRMED"
      )
        continue;
      const principal =
        observation.capScope === "UNKNOWN" || observation.capRaw >= runtime.priceBatchWei
          ? runtime.priceBatchWei
          : observation.capRaw;
      if (principal <= 0n) continue;
      try {
        const expected = await runtime.pool.previewBuyRaw(principal, blockNumber);
        quotes.set(
          lane.laneId,
          createQuoteSnapshot({
            laneId: lane.laneId,
            poolObservationId: observation.observationId,
            profileRevision: profile.mechanism.revision,
            blockNumber,
            blockHash: observation.block.blockHash,
            principalRaw: principal,
            expectedTokenOutRaw: expected,
            observedAtMs: Date.now(),
            expiresAtMs: Date.now() + profile.entry.quoteMaximumAgeMs,
            evidenceIds: Object.freeze([observation.observationId]),
          }),
        );
      } catch (error) {
        log("ERROR", "later-lane preview unavailable", {
          laneId: lane.laneId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const decisions = runtime.orchestrator.observe(observation, identityLevel, quotes);
    await Promise.all(
      decisions.map(async (decision) => {
        const expected =
          decision.trancheNumber === 1
            ? runtime.canaryExpectedOutputRaw
            : quotes.get(decision.laneId)?.expectedTokenOutRaw;
        if (expected === undefined)
          throw new Error(`lane ${decision.laneId} has no exact-block quote`);
        try {
          await dispatchLane(runtime, decision, observation.block.blockHash, blockNumber, expected);
        } catch (error) {
          runtime.orchestrator.recordLaneOutcome(
            decision.laneId,
            error instanceof ProvenPreBroadcastFailure ? "REVERTED" : "UNKNOWN",
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
      }),
    );
  };

  const discovered = await discoverConfiguredClockInLaunch({
    requester: canonical,
    wssUrl: rpcWss,
    profile,
    signal: shutdown.signal,
    onEvent: async (event) => {
      log("INFO", `Factory discovery ${event.kind.toLowerCase()}`);
      await writeStatus("WATCHING", [event.kind]);
    },
  });
  const code = await verifyConfiguredCodeIdentity({
    requester: canonical,
    profile,
    blockNumber: discovered.log.blockNumber,
    identity: Object.freeze({
      ...discovered.candidate,
      launchId: "pre-freeze",
      tokenRuntimeCodeHash: profile.mechanism.tokenRuntimeCodeHashes[0] as `0x${string}`,
      poolRuntimeCodeHash: profile.mechanism.poolRuntimeCodeHashes[0] as `0x${string}`,
      mechanismProfileId: profile.mechanism.profileId,
      identityPolicyHash: "pre-freeze",
      configHash: CLOCKIN_POLICY_V2.configHash,
      frozenAt: new Date().toISOString(),
      state: "FROZEN",
    }),
  });
  if (code.tokenCodeHash === undefined || code.poolCodeHash === undefined) {
    throw new Error("token and pool code identity were not read");
  }
  const frozenAt = new Date().toISOString();
  const proposedIdentity = freezeLaunchIdentity({
    candidate: discovered.candidate,
    policy: identityPolicy(profile),
    tokenRuntimeCodeHash: code.tokenCodeHash,
    poolRuntimeCodeHash: code.poolCodeHash,
    mechanismProfileId: profile.mechanism.profileId,
    configHash: CLOCKIN_POLICY_V2.configHash,
    frozenAt,
  });
  const restoredIdentity = store
    .latestLaunchIdentities(STRATEGY_ID)
    .find(
      (candidate) =>
        candidate.transactionHash.toLowerCase() ===
          proposedIdentity.transactionHash.toLowerCase() &&
        candidate.logIndex === proposedIdentity.logIndex,
    );
  if (
    restoredIdentity !== undefined &&
    (restoredIdentity.tokenAddress.toLowerCase() !== proposedIdentity.tokenAddress.toLowerCase() ||
      restoredIdentity.poolAddress.toLowerCase() !== proposedIdentity.poolAddress.toLowerCase())
  ) {
    throw new Error("restored launch identity conflicts with the current exact Factory log");
  }
  const identity = restoredIdentity ?? proposedIdentity;
  const identityCreated = restoredIdentity === undefined && store.saveLaunchIdentity(identity);
  log(
    "INFO",
    identityCreated ? "new ClockIn identity persisted" : "existing ClockIn identity restored",
  );
  const latestPrice = priceCache.current();
  readiness = await inspectWalletReadiness(canonical, walletBundle.manifest, {
    batchValueWei: latestPrice.batchValueWei,
    entryGasLimit: BigInt(profile.entry.gasLimit),
    entryMaxFeePerGasWei: BigInt(profile.entry.maximumFeePerGasWei),
    approvalGasLimit: maximumExitGas.approval,
    sellGasLimit: maximumExitGas.sell,
    exitMaxFeePerGasWei: maximumExitGas.fee,
    maximumSellTransactions: CLOCKIN_POLICY_V2.maximumSellTransactionsPerWallet,
    gasSafetyMarginBps: CLOCKIN_POLICY_V2.gasSafetyMarginBps,
    aggregateAllInCapWei:
      (CLOCKIN_POLICY_V2.allInRiskCapUsdMicros * 1_000_000_000_000_000_000n) /
      latestPrice.primary.usdMicrosPerEth,
    automaticTopUpAllowed: false,
  });
  if (!readiness.hotArmed) throw new Error("wallet readiness changed before launch dispatch");
  readinessByWalletId = new Map(readiness.rows.map((row) => [row.walletId, row] as const));
  const reservationIds = Array.from(
    { length: 10 },
    (_, index) => `${identity.launchId}:reservation-${String(index + 1).padStart(2, "0")}`,
  );
  const feePlan = planTenFeeBands(
    profile.mechanism.maximumInitialFeeBps,
    profile.mechanism.floorFeeBps,
    walletBundle.manifest.entries.map((entry) => entry.walletId),
    reservationIds,
    CLOCKIN_POLICY_V2.nominalLaneUsdMicros,
    {
      strategyId: STRATEGY_ID,
      launchId: identity.launchId,
      mechanismProfileRevision: profile.mechanism.revision,
      createdAt: frozenAt,
    },
  );
  store.saveFeeBandPlan(feePlan);
  const lanes: readonly WalletLane[] = Object.freeze(
    feePlan.lanes.map((lane, index) => {
      const entry = walletBundle.manifest.entries[index];
      if (entry === undefined) throw new Error("wallet manifest is shorter than fee plan");
      return Object.freeze({
        laneId: lane.laneId,
        strategyId: STRATEGY_ID,
        revision: 1,
        walletId: lane.walletId,
        address: entry.address,
        role: "CLOCKIN_ENTRY" as const,
        trancheNumber: lane.trancheNumber,
        maxPrincipalRaw: CLOCKIN_POLICY_V2.nominalLaneUsdMicros.toString(),
        evidenceIds: Object.freeze([authorization.authorizationId, feePlan.plannerRevision]),
        state: "UNALLOCATED" as const,
        createdAt: frozenAt,
        updatedAt: frozenAt,
      });
    }),
  );
  store.initializeBudget(
    Object.freeze({
      budgetId: `${identity.launchId}:budget`,
      strategyId: STRATEGY_ID,
      revision: 1,
      launchId: identity.launchId,
      configHash: CLOCKIN_POLICY_V2.configHash,
      nominalUnit: "USD_MICROS",
      principalLimit: CLOCKIN_POLICY_V2.clockInBudgetUsdMicros.toString(),
      evidenceIds: Object.freeze([authorization.authorizationId]),
      createdAt: frozenAt,
      updatedAt: frozenAt,
    }),
    lanes,
  );
  const pool = new ConfiguredLauncherPoolRuntime({ requester: canonical, profile, identity });
  const launchObservation = await pool.observe(discovered.log.blockNumber, identity.evidenceIds);
  const canaryExpectedOutputRaw = await pool.previewBuyRaw(
    latestPrice.batchValueWei,
    discovered.log.blockNumber,
  );
  const orchestrator = new TenLaneOrchestrator(feePlan, {
    batchPrincipalRaw: latestPrice.batchValueWei,
    minimumShrunkPrincipalRaw:
      (latestPrice.batchValueWei * CLOCKIN_POLICY_V2.minimumShrunkLaneUsdMicros) /
      CLOCKIN_POLICY_V2.nominalLaneUsdMicros,
    aggregatePrincipalCapRaw: latestPrice.batchValueWei * 10n,
    catchUpPolicy: CLOCKIN_POLICY_V2.catchUpPolicy,
    maxConcurrentCatchUpLanes: CLOCKIN_POLICY_V2.maxConcurrentCatchUpLanes,
    capPolicy: CLOCKIN_POLICY_V2.capPolicy,
  });
  const restoredEffects = store.latestEffectRecords(STRATEGY_ID, identity.launchId);
  const restoredAttempts = store.latestTxAttempts(STRATEGY_ID, identity.launchId);
  for (const plan of store.latestExecutionPlans(STRATEGY_ID, identity.launchId)) {
    const effect = restoredEffects.find((candidate) => candidate.laneId === plan.laneId);
    const attempt = restoredAttempts.find((candidate) => candidate.planId === plan.planId);
    const state =
      effect?.result === "SUCCESS"
        ? ("EFFECT_CONFIRMED" as const)
        : plan.state === "INVALIDATED" ||
            effect?.result === "REVERTED" ||
            attempt?.state === "CONFIRMED_REVERTED" ||
            attempt?.state === "DROPPED_PROVEN"
          ? ("FAILED_FINAL" as const)
          : attempt?.state === "UNKNOWN"
            ? ("UNKNOWN" as const)
            : ("DISPATCHED" as const);
    orchestrator.restoreLane({
      laneId: plan.laneId,
      state,
      dispatchedPrincipalRaw: BigInt(plan.valueRaw),
      reason: `restored from plan ${plan.planId}`,
    });
  }
  const officialCa = new OfficialCaMonitor({
    expectedToken: identity.tokenAddress,
    url: profile.identity.officialCa.url,
    jsonKey: profile.identity.officialCa.jsonKey,
    pollMs: profile.identity.officialCa.pollMs,
    onChange: (snapshot) => {
      log(snapshot.state === "mismatch" ? "ERROR" : "INFO", "official CA state changed", {
        state: snapshot.state,
        observedAddress: snapshot.observedAddress,
      });
    },
  });
  void officialCa.start().catch((error: unknown) =>
    log("ERROR", "official CA monitor failed", {
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  currentLaunch = {
    identity,
    pool,
    feePlan,
    orchestrator,
    priceBatchWei: latestPrice.batchValueWei,
    canaryExpectedOutputRaw,
    canaryQuoteId: `canary:${stableHash({ identity: identity.launchId, block: identity.blockNumber })}`,
    officialCa,
    expiresAtMs:
      Number(
        launchObservation.block.blockTimestamp + BigInt(profile.mechanism.decayWindowSeconds),
      ) * 1_000,
    canaryApplied: false,
  };
  await writeStatus("ACTIVE", ["CLOCKIN_IDENTITY_FROZEN", `SOURCE_${discovered.source}`]);
  log("ACTION", "ClockIn identity frozen", {
    launchId: identity.launchId,
    tokenAddress: identity.tokenAddress,
    poolAddress: identity.poolAddress,
    blockNumber: identity.blockNumber,
  });
  await processHead(currentLaunch, discovered.log.blockNumber);

  let headQueue = Promise.resolve();
  const headsClient = new WebSocketNewHeadsClient({
    providerId: "production-wss-heads",
    url: rpcWss,
    setupTimeoutMs: 8_000,
  });
  headsSubscription = await headsClient.subscribe((head) => {
    headQueue = headQueue
      .then(async () => {
        if (currentLaunch !== null) await processHead(currentLaunch, head.blockNumber);
      })
      .catch((error: unknown) => {
        log("ERROR", "head processing failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });

  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    shutdown.abort();
    headsSubscription?.close();
    currentLaunch?.officialCa.stop();
    if (leaseTimer !== null) clearInterval(leaseTimer);
    if (statusTimer !== null) clearInterval(statusTimer);
    if (priceTimer !== null) clearInterval(priceTimer);
    await headQueue;
    releaseEligibleLeases(true);
    await writeStatus("STOPPING", [signal]);
    await watchdog.stopping(`executor stopping after ${signal}`);
    store.close();
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
  await headsSubscription.done;
  if (!stopping) throw new Error("newHeads subscription ended unexpectedly");
}

void main().catch(async (error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      service: "clockin-executor",
      state: "FAILED",
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
