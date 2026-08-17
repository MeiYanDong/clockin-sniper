import { hostname } from "node:os";

import { ZeroAddress, keccak256 } from "ethers";

import {
  ConfiguredExitRouteRuntime,
  type ConfiguredApprovalTemplate,
  type ConfiguredExitQuote,
  type ConfiguredSellTemplate,
} from "./adapters/configured-exit.js";
import { SameRawBroadcaster } from "./broadcast/same-raw-broadcaster.js";
import { CLOCKIN_POLICY_V2 } from "./config/strategy-config.js";
import {
  stableHash,
  type Address,
  type AggregatePosition,
  type ExitPlan,
  type LaunchIdentity,
  type PositionLot,
  type RouteQuote,
  type TxAttempt,
} from "./core/canonical.js";
import { decidePrePrincipalDownside, type DownsidePolicyState } from "./exit/downside-policy.js";
import { buildExitPlan } from "./exit/exit-plan-builder.js";
import {
  decidePrincipalFirstExit,
  type LotExitInstruction,
  type RunnerState,
} from "./exit/principal-recovery.js";
import { selectBestExecutableRoute } from "./exit/route-quote.js";
import { SqliteStore } from "./persistence/sqlite-store.js";
import { aggregatePosition, reconcileLotBalance } from "./positions/position-book.js";
import { HttpJsonRpcClient } from "./rpc/http-json-rpc.js";
import { assertPaidRpcApproved } from "./runtime/paid-rpc-approval.js";
import { hexToBigInt, quantityToHex } from "./rpc/hex.js";
import {
  loadProductionProfileAndAuthorization,
  loadProductionWalletSigners,
  loadVaultKey,
  readSystemdCredential,
  type LoadedWalletSigner,
} from "./runtime/credentials.js";
import {
  ProductionSameRawProvider,
  readGenesisHash,
  readNativeBalance,
  readTokenBalance,
} from "./runtime/production-rpc.js";
import type {
  ProductionAuthorization,
  ProductionExitRoute,
  ProductionProtocolProfile,
} from "./runtime/production-profile.js";
import { writeProductionServiceStatus } from "./runtime/service-status.js";
import type {
  ExitApprovalBroadcastSnapshot,
  ExitSellBroadcastSnapshot,
  ProductionBroadcastSnapshot,
} from "./runtime/transaction-snapshots.js";
import { snapshotEventKind } from "./runtime/transaction-snapshots.js";
import { SystemdWatchdog } from "./runtime/systemd-watchdog.js";
import { SignedTxVault } from "./wallets/signed-tx-vault.js";
import { WalletTransactionCoordinator, type NonceSlot } from "./wallets/transaction-coordinator.js";

const STRATEGY_ID = "clockin-mainnet-v1";
const STATUS_DIRECTORY = process.env.CLOCKIN_STATUS_DIR?.trim() || "/run/clockin-status";
const STATE_DIRECTORY = process.env.CLOCKIN_STATE_DIR?.trim() || "/var/lib/clockin-sniper";
const LEASE_TTL_MS = 30_000;
const EXIT_DEADLINE_SECONDS = 60n;

type TransactionTemplate = ConfiguredApprovalTemplate | ConfiguredSellTemplate;

interface ActiveLease {
  readonly walletAddress: Address;
  readonly epoch: number;
}

interface BoundRouteQuote {
  readonly runtime: ConfiguredExitRouteRuntime;
  readonly result: ConfiguredExitQuote;
}

interface ExitRuntime {
  readonly profile: ProductionProtocolProfile;
  readonly authorization: ProductionAuthorization;
  readonly signerByAddress: ReadonlyMap<string, LoadedWalletSigner>;
  readonly routeProfiles: readonly ProductionExitRoute[];
}

function log(kind: "INFO" | "ACTION" | "ERROR", message: string, details: object = {}): void {
  process.stdout.write(
    `${JSON.stringify({ service: "clockin-exit", kind, message, ...details })}\n`,
  );
}

function expiry(nowMs: number): string {
  return new Date(nowMs + LEASE_TTL_MS).toISOString();
}

function transportState(state: "ACCEPTED" | "KNOWN" | "UNKNOWN" | "REJECTED"): TxAttempt["state"] {
  if (state === "ACCEPTED" || state === "KNOWN") return "ACCEPTED";
  return state === "UNKNOWN" ? "UNKNOWN" : "DROPPED_PROVEN";
}

function reviseExitPlan(plan: ExitPlan, state: ExitPlan["state"]): ExitPlan {
  return Object.freeze({
    ...plan,
    revision: plan.revision + 1,
    state,
    updatedAt: new Date().toISOString(),
  });
}

function actualRecoveredProceeds(store: SqliteStore, launchId: string): bigint {
  return store.latestEffectRecords(STRATEGY_ID, launchId).reduce((total, effect) => {
    if (
      effect.side !== "EXIT" ||
      effect.canonicality !== "CANONICAL" ||
      effect.principalDeltaRaw.state !== "KNOWN"
    ) {
      return total;
    }
    const value = BigInt(effect.principalDeltaRaw.value);
    return value > 0n ? total + value : total;
  }, 0n);
}

function approvalGasSpent(store: SqliteStore, launchId: string): bigint {
  return store.auditEvents(STRATEGY_ID, launchId).reduce((total, event) => {
    if (event.eventKind !== "EXIT_APPROVAL_CANONICAL") return total;
    const payload = event.payload as Record<string, unknown>;
    if (payload.receiptStatus !== 1 || typeof payload.gasCostRaw !== "string") return total;
    return /^(0|[1-9][0-9]*)$/u.test(payload.gasCostRaw)
      ? total + BigInt(payload.gasCostRaw)
      : total;
  }, 0n);
}

function withApprovalCost(position: AggregatePosition, costRaw: bigint): AggregatePosition {
  return Object.freeze({
    ...position,
    totalActualCostRaw: (BigInt(position.totalActualCostRaw) + costRaw).toString(),
  });
}

function allLotInstructions(
  lots: readonly PositionLot[],
  quotesByLotId: ReadonlyMap<string, RouteQuote>,
): readonly LotExitInstruction[] {
  return Object.freeze(
    lots.flatMap((lot) => {
      const quote = quotesByLotId.get(lot.lotId);
      if (quote === undefined || BigInt(quote.netOutputRaw) <= 0n) return [];
      return [
        Object.freeze({
          lotId: lot.lotId,
          walletAddress: lot.walletAddress,
          routeQuoteId: quote.quoteId,
          tokenInputRaw: BigInt(lot.remainingRaw),
          expectedNetOutputRaw: BigInt(quote.netOutputRaw),
        }),
      ];
    }),
  );
}

function restoreRunnerState(
  store: SqliteStore,
  identity: LaunchIdentity,
  lots: readonly PositionLot[],
): RunnerState {
  const latest = [...store.auditEvents(STRATEGY_ID, identity.launchId)]
    .reverse()
    .find((event) => event.eventKind === "EXIT_POLICY_EVALUATED");
  const payload = latest?.payload as Record<string, unknown> | undefined;
  const peak =
    typeof payload?.updatedRunnerPeakRaw === "string" &&
    /^(0|[1-9][0-9]*)$/u.test(payload.updatedRunnerPeakRaw)
      ? BigInt(payload.updatedRunnerPeakRaw)
      : 0n;
  const openedAt = Math.min(...lots.map((lot) => Date.parse(lot.createdAt)));
  if (!Number.isFinite(openedAt)) throw new Error("position lot has an invalid creation time");
  return Object.freeze({
    executableNetPeakRaw: peak,
    positionOpenedAtMs: openedAt,
    momentumFailed: false,
  });
}

function restoreDownsideState(
  store: SqliteStore,
  identity: LaunchIdentity,
): DownsidePolicyState | null {
  const latest = [...store.auditEvents(STRATEGY_ID, identity.launchId)]
    .reverse()
    .find((event) => event.eventKind === "EXIT_DOWNSIDE_STATE");
  if (latest === undefined) return null;
  const payload = latest.payload as Record<string, unknown>;
  const opened = Number(payload.positionOpenedAtMs);
  const baseline =
    typeof payload.postEntryExecutableNetBaselineRaw === "string"
      ? BigInt(payload.postEntryExecutableNetBaselineRaw)
      : -1n;
  const lastBlock =
    payload.lastCanonicalBlockNumber === null
      ? null
      : typeof payload.lastCanonicalBlockNumber === "string"
        ? BigInt(payload.lastCanonicalBlockNumber)
        : -1n;
  const consecutive = Number(payload.consecutiveBelowStopBlocks);
  if (
    !Number.isSafeInteger(opened) ||
    opened < 0 ||
    baseline <= 0n ||
    (lastBlock !== null && lastBlock < 0n) ||
    !Number.isSafeInteger(consecutive) ||
    consecutive < 0
  ) {
    throw new Error("persisted downside state is invalid");
  }
  return Object.freeze({
    positionOpenedAtMs: opened,
    postEntryExecutableNetBaselineRaw: baseline,
    lastCanonicalBlockNumber: lastBlock,
    consecutiveBelowStopBlocks: consecutive,
  });
}

async function main(): Promise<void> {
  const ownerId = process.env.CLOCKIN_EXIT_ID?.trim() || `clockin-exit:${hostname()}`;
  const watchdog = new SystemdWatchdog();
  let stopping = false;
  let working = false;
  let sequence = 0;
  let lastProcessedHead = -1n;
  await assertPaidRpcApproved();
  const [walletBundle, rpcHttp, sequencerHttp, vaultKey] = await Promise.all([
    loadProductionWalletSigners(),
    readSystemdCredential("rpc_http"),
    readSystemdCredential("sequencer_http"),
    loadVaultKey(),
  ]);
  const { profile, authorization } = await loadProductionProfileAndAuthorization(
    walletBundle.manifest,
  );
  const canonical = new HttpJsonRpcClient({
    providerId: "production-http",
    url: rpcHttp,
    timeoutMs: 5_000,
  });
  const sequencer = new HttpJsonRpcClient({
    providerId: "official-sequencer",
    url: sequencerHttp,
    timeoutMs: 2_000,
  });
  const store = new SqliteStore(`${STATE_DIRECTORY}/canonical.sqlite`);
  const vault = new SignedTxVault(`${STATE_DIRECTORY}/vault`, vaultKey);
  const coordinator = new WalletTransactionCoordinator(store);
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
  const activeLeases = new Map<string, ActiveLease>();
  const verifiedRouteIds = new Set<string>();
  const runtime: ExitRuntime = Object.freeze({
    profile,
    authorization,
    signerByAddress: new Map(
      walletBundle.signers.map(
        (binding) => [binding.entry.address.toLowerCase(), binding] as const,
      ),
    ),
    routeProfiles: profile.exit.routes,
  });

  const headAtStartup = hexToBigInt(
    "eth_blockNumber",
    await canonical.request<string>("eth_blockNumber"),
  );
  for (const route of runtime.routeProfiles) {
    if (route.targetMode !== "FIXED") continue;
    const configured = new ConfiguredExitRouteRuntime({ requester: canonical, profile, route });
    await configured.verifyCodeIdentity(headAtStartup);
    verifiedRouteIds.add(route.routeId);
  }

  const writeStatus = async (
    state: "BOOTING" | "WATCHING" | "READY" | "ACTIVE" | "DEGRADED" | "STOPPING" | "FAILED",
    details: readonly string[] = [],
  ): Promise<void> => {
    sequence += 1;
    const now = new Date().toISOString();
    const leasesOwned = [...activeLeases.values()].every((lease) =>
      store.ownsServiceLease(
        `wallet:${lease.walletAddress.toLowerCase()}`,
        ownerId,
        lease.epoch,
        now,
      ),
    );
    await writeProductionServiceStatus(STATUS_DIRECTORY, {
      formatVersion: 1,
      service: "exit",
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
      entryEnabled: false,
      exitEnabled: !stopping && Date.now() < Date.parse(authorization.expiresAt),
      unresolvedAttemptCount: store.unresolvedTxAttempts(STRATEGY_ID).length,
      openPositionCount: store.latestOpenPositionLots(STRATEGY_ID).length,
      verifiedExitRouteCount: verifiedRouteIds.size,
      details: Object.freeze([...details, `ACTIVE_WALLET_LEASES_${activeLeases.size}`]),
    });
  };

  const releaseLease = (walletAddress: Address): void => {
    const key = walletAddress.toLowerCase();
    const binding = activeLeases.get(key);
    if (binding === undefined) return;
    store.releaseServiceLease(`wallet:${key}`, ownerId, binding.epoch, new Date().toISOString());
    activeLeases.delete(key);
  };

  const cleanupAndRenewLeases = (): void => {
    const now = new Date().toISOString();
    for (const binding of [...activeLeases.values()]) {
      if (!store.walletHasUnresolvedNonce(binding.walletAddress)) {
        releaseLease(binding.walletAddress);
        continue;
      }
      store.renewServiceLease(
        `wallet:${binding.walletAddress.toLowerCase()}`,
        ownerId,
        binding.epoch,
        expiry(Date.parse(now)),
        now,
      );
    }
  };

  const acquireLease = async (walletAddress: Address): Promise<ActiveLease> => {
    coordinator.assertExitAllowed(walletAddress);
    const [latestRaw, pendingRaw] = await Promise.all([
      canonical.request<string>("eth_getTransactionCount", [walletAddress, "latest"]),
      canonical.request<string>("eth_getTransactionCount", [walletAddress, "pending"]),
    ]);
    const latest = hexToBigInt("latest nonce", latestRaw);
    const pending = hexToBigInt("pending nonce", pendingRaw);
    const now = new Date().toISOString();
    const epoch = coordinator.acquire(
      walletAddress,
      ownerId,
      latest,
      pending,
      now,
      expiry(Date.parse(now)),
    );
    const binding = Object.freeze({ walletAddress, epoch });
    activeLeases.set(walletAddress.toLowerCase(), binding);
    return binding;
  };

  const submit = async (input: {
    readonly signer: LoadedWalletSigner;
    readonly launchId: string;
    readonly laneId: string;
    readonly intentId: string;
    readonly planId: string;
    readonly template: TransactionTemplate;
    readonly snapshot: ProductionBroadcastSnapshot;
  }): Promise<TxAttempt["state"]> => {
    if (Date.now() >= Date.parse(runtime.authorization.expiresAt)) {
      throw new Error("production exit authorization expired");
    }
    const lease = await acquireLease(input.signer.entry.address);
    const nonceRaw = await canonical.request<string>("eth_getTransactionCount", [
      input.signer.entry.address,
      "pending",
    ]);
    const nonce = hexToBigInt("pending nonce", nonceRaw);
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
      releaseLease(input.signer.entry.address);
      throw new RangeError("wallet nonce cannot be represented by the signer transaction API");
    }
    const now = new Date().toISOString();
    let slot: NonceSlot | null = null;
    let vaultRef: string | null = null;
    let possiblySubmitted = false;
    try {
      slot = coordinator.reserve(
        input.signer.entry.address,
        ownerId,
        lease.epoch,
        nonce,
        "EXIT",
        input.planId,
        now,
      );
      const raw = (await input.signer.signer.signTransaction({
        chainId: 4_663,
        type: 2,
        nonce: Number(nonce),
        to: input.template.to,
        value: input.template.valueRaw,
        data: input.template.calldata,
        gasLimit: input.template.gasLimit,
        maxFeePerGas: input.template.maxFeePerGas,
        maxPriorityFeePerGas: input.template.maxPriorityFeePerGas,
      })) as `0x${string}`;
      const txHash = keccak256(raw) as `0x${string}`;
      vaultRef = await vault.put(raw, now);
      slot = coordinator.transition(slot, "SIGNED", now);
      const attemptId = `tx-attempt:${stableHash({ planId: input.planId, txHash })}`;
      const baseAttempt: TxAttempt = Object.freeze({
        attemptId,
        strategyId: STRATEGY_ID,
        revision: 1,
        intentId: input.intentId,
        planId: input.planId,
        launchId: input.launchId,
        laneId: input.laneId,
        walletAddress: input.signer.entry.address,
        nonce: nonce.toString(),
        operation: "INITIAL",
        signedTxHash: txHash,
        payloadHash: `keccak256:${txHash.slice(2)}`,
        vaultRef,
        transportEvents: Object.freeze([]),
        state: "SIGNED",
        evidenceIds: Object.freeze([input.planId, runtime.authorization.authorizationId]),
        createdAt: now,
        updatedAt: now,
      });
      store.saveTxAttempt(baseAttempt);
      store.appendAuditEvent({
        eventId: `pre-broadcast:${attemptId}`,
        eventKind: snapshotEventKind(input.snapshot),
        strategyId: STRATEGY_ID,
        launchId: input.launchId,
        objectId: attemptId,
        payload: input.snapshot,
        observedAt: now,
      });
      slot = coordinator.transition(slot, "POSSIBLY_SUBMITTED", now);
      possiblySubmitted = true;
      const result = await broadcaster.broadcast(raw);
      const updatedAt = new Date().toISOString();
      const state = transportState(result.state);
      store.saveTxAttempt(
        Object.freeze({
          ...baseAttempt,
          revision: 2,
          state,
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
        }),
      );
      if (state === "UNKNOWN") coordinator.transition(slot, "UNKNOWN", updatedAt);
      if (state === "DROPPED_PROVEN") {
        coordinator.releaseAfterDeterministicRejection(
          slot,
          {
            allRoutesRejected: true,
            signedHashUnchanged: result.txHash.toLowerCase() === txHash.toLowerCase(),
          },
          updatedAt,
        );
        await vault.remove(vaultRef);
        releaseLease(input.signer.entry.address);
      }
      log("ACTION", "exit transaction broadcast completed", {
        attemptId,
        planId: input.planId,
        txHash,
        transportState: result.state,
        operation: input.snapshot.kind,
      });
      return state;
    } catch (error) {
      if (slot !== null && !possiblySubmitted) {
        try {
          coordinator.transition(slot, "RELEASED");
        } catch {
          // The original error remains primary; persisted ownership still fails closed.
        }
      } else if (slot !== null && possiblySubmitted) {
        try {
          coordinator.transition(slot, "UNKNOWN");
        } catch {
          // A possibly submitted nonce is deliberately retained for the reconciler.
        }
      }
      if (vaultRef !== null && !possiblySubmitted)
        await vault.remove(vaultRef).catch(() => undefined);
      if (!possiblySubmitted) {
        try {
          releaseLease(input.signer.entry.address);
        } catch {
          // Lease expiry remains the fallback fence.
        }
      }
      throw error;
    }
  };

  const executeInstruction = async (input: {
    readonly position: AggregatePosition;
    readonly lot: PositionLot;
    readonly instruction: LotExitInstruction;
    readonly boundQuote: BoundRouteQuote;
    readonly policyStage: ExitPlan["policyStage"];
    readonly head: bigint;
  }): Promise<void> => {
    if (store.walletHasUnresolvedNonce(input.lot.walletAddress)) return;
    const signer = runtime.signerByAddress.get(input.lot.walletAddress.toLowerCase());
    if (signer === undefined) throw new Error(`position ${input.lot.lotId} has no bound signer`);
    const audit = store.auditEvents(STRATEGY_ID, input.lot.launchId);
    const sellCount = audit.filter(
      (event) =>
        event.eventKind === "EXIT_SELL_PRE_BROADCAST_SNAPSHOT" &&
        (event.payload as Record<string, unknown>).lotId === input.lot.lotId,
    ).length;
    if (sellCount >= CLOCKIN_POLICY_V2.maximumSellTransactionsPerWallet) {
      throw new Error(`wallet ${signer.entry.walletId} reached the bounded sell transaction count`);
    }
    if (input.boundQuote.result.approvalRequired) {
      const route = input.boundQuote.runtime.route;
      const approvalSpender = input.boundQuote.runtime.approvalSpender;
      if (approvalSpender === undefined) throw new Error("approval route has no spender");
      const approvalCount = audit.filter(
        (event) =>
          event.eventKind === "EXIT_APPROVAL_PRE_BROADCAST_SNAPSHOT" &&
          (event.payload as Record<string, unknown>).lotId === input.lot.lotId &&
          (event.payload as Record<string, unknown>).routeId === route.routeId,
      ).length;
      if (approvalCount >= CLOCKIN_POLICY_V2.maximumSellTransactionsPerWallet) {
        throw new Error(`wallet ${signer.entry.walletId} reached the bounded approval count`);
      }
      const planId = `exit-approval-plan:${stableHash({
        lotId: input.lot.lotId,
        routeId: route.routeId,
        revision: approvalCount + 1,
      })}`;
      const snapshot: ExitApprovalBroadcastSnapshot = Object.freeze({
        formatVersion: 1,
        kind: "EXIT_APPROVAL",
        validityExpiresAt: input.boundQuote.result.quote.expiresAt,
        lotId: input.lot.lotId,
        routeId: route.routeId,
        tokenAddress: input.lot.tokenAddress,
        spender: approvalSpender,
        expectedAllowanceRaw: input.lot.remainingRaw,
      });
      await submit({
        signer,
        launchId: input.lot.launchId,
        laneId: input.lot.laneId,
        intentId: `exit-approval-intent:${stableHash({ planId })}`,
        planId,
        template: input.boundQuote.runtime.buildApproval(
          input.lot.tokenAddress,
          BigInt(input.lot.remainingRaw),
        ),
        snapshot,
      });
      return;
    }
    const currentHead = hexToBigInt(
      "eth_blockNumber",
      await canonical.request<string>("eth_blockNumber"),
    );
    if (currentHead !== input.head) throw new Error("exit quote head changed before signing");
    const now = new Date().toISOString();
    const plan = buildExitPlan({
      position: input.position,
      lot: input.lot,
      quote: input.boundQuote.result.quote,
      tokenInputRaw: input.instruction.tokenInputRaw,
      policyStage: input.policyStage,
      maximumSlippageBps: CLOCKIN_POLICY_V2.routineExitMaximumSlippageBps,
      validityEnvelopeId: `exit-validity:${input.boundQuote.result.quote.quoteId}`,
      now,
    });
    store.saveExitPlan(plan);
    const template = input.boundQuote.runtime.buildSell({
      lot: input.lot,
      quote: input.boundQuote.result.quote,
      tokenInputRaw: input.instruction.tokenInputRaw,
      minOutputRaw: BigInt(plan.minOutputRaw),
      deadlineTimestamp: input.boundQuote.result.quoteBlockTimestamp + EXIT_DEADLINE_SECONDS,
    });
    const [tokenBefore, quoteBefore] = await Promise.all([
      readTokenBalance(canonical, input.lot.tokenAddress, input.lot.walletAddress, input.head),
      readNativeBalance(canonical, input.lot.walletAddress, input.head),
    ]);
    if (tokenBefore < input.instruction.tokenInputRaw) {
      throw new Error("wallet token balance fell below the frozen exit input");
    }
    const snapshot: ExitSellBroadcastSnapshot = Object.freeze({
      formatVersion: 1,
      kind: "EXIT_SELL",
      validityExpiresAt: input.boundQuote.result.quote.expiresAt,
      exitPlanId: plan.exitPlanId,
      lotId: input.lot.lotId,
      routeQuoteId: input.boundQuote.result.quote.quoteId,
      quoteAsset: ZeroAddress as Address,
      tokenBalanceBeforeRaw: tokenBefore.toString(),
      quoteBalanceBeforeRaw: quoteBefore.toString(),
      expectedTokenInputRaw: input.instruction.tokenInputRaw.toString(),
      minimumQuoteOutputRaw: plan.minOutputRaw,
    });
    try {
      const state = await submit({
        signer,
        launchId: input.lot.launchId,
        laneId: input.lot.laneId,
        intentId: `exit-intent:${stableHash({ exitPlanId: plan.exitPlanId })}`,
        planId: plan.exitPlanId,
        template,
        snapshot,
      });
      store.saveExitPlan(
        reviseExitPlan(plan, state === "DROPPED_PROVEN" ? "FAILED_RECOVERABLE" : "EXECUTING"),
      );
    } catch (error) {
      store.saveExitPlan(reviseExitPlan(plan, "FAILED_RECOVERABLE"));
      throw error;
    }
  };

  const processLaunch = async (
    identity: LaunchIdentity,
    inputLots: readonly PositionLot[],
    head: bigint,
  ): Promise<void> => {
    const eligibleLots: PositionLot[] = [];
    for (const lot of inputLots) {
      if (lot.state === "UNKNOWN" || store.walletHasUnresolvedNonce(lot.walletAddress)) continue;
      const balance = await readTokenBalance(canonical, lot.tokenAddress, lot.walletAddress, head);
      const reconciled = reconcileLotBalance(
        lot,
        balance,
        new Date().toISOString(),
        `balance:${head}:${lot.walletAddress}`,
      );
      if (reconciled !== lot) {
        store.savePositionLot(reconciled);
        log("ERROR", "position balance mismatch quarantined", { lotId: lot.lotId });
        continue;
      }
      eligibleLots.push(lot);
    }
    if (eligibleLots.length === 0) return;
    const launchRoutes = runtime.routeProfiles.map(
      (route) =>
        new ConfiguredExitRouteRuntime({
          requester: canonical,
          profile,
          route,
          ...(route.targetMode === "LAUNCH_POOL" ? { identity } : {}),
        }),
    );
    const boundByQuoteId = new Map<string, BoundRouteQuote>();
    const quotesByLotId = new Map<string, RouteQuote>();
    for (const lot of eligibleLots) {
      const candidates: BoundRouteQuote[] = [];
      for (const route of launchRoutes) {
        try {
          const result = await route.quoteLot(lot, head);
          store.saveRouteQuote(result.quote);
          verifiedRouteIds.add(route.route.routeId);
          const bound = Object.freeze({ runtime: route, result });
          candidates.push(bound);
          boundByQuoteId.set(result.quote.quoteId, bound);
        } catch (error) {
          verifiedRouteIds.delete(route.route.routeId);
          log("ERROR", "verified exit route is not executable", {
            launchId: identity.launchId,
            lotId: lot.lotId,
            routeId: route.route.routeId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const best = selectBestExecutableRoute(
        candidates.map((candidate) => candidate.result.quote),
        new Date().toISOString(),
      );
      if (best !== null) quotesByLotId.set(lot.lotId, best);
    }
    const recovered = actualRecoveredProceeds(store, identity.launchId);
    const aggregated = aggregatePosition({
      lots: inputLots,
      quotesByLotId,
      realizedProceedsRaw: recovered,
      observedAt: new Date().toISOString(),
      evidenceIds: Object.freeze([`head:${head}`]),
    });
    const position = withApprovalCost(
      aggregated.position,
      approvalGasSpent(store, identity.launchId),
    );
    if (aggregated.unvaluedLotIds.length > 0) {
      const eventId = `exit-incomplete-valuation:${identity.launchId}:${head}`;
      const existing = store
        .auditEvents(STRATEGY_ID, identity.launchId)
        .some((event) => event.eventId === eventId);
      if (!existing) {
        store.appendAuditEvent({
          eventId,
          eventKind: "EXIT_POLICY_INCOMPLETE_VALUATION",
          strategyId: STRATEGY_ID,
          launchId: identity.launchId,
          objectId: position.positionId,
          payload: { unvaluedLotIds: aggregated.unvaluedLotIds },
          observedAt: new Date().toISOString(),
        });
      }
      log("ERROR", "exit policy held because the position valuation is incomplete", {
        launchId: identity.launchId,
        unvaluedLotIds: aggregated.unvaluedLotIds,
      });
      return;
    }
    const runner = restoreRunnerState(store, identity, inputLots);
    const policy = decidePrincipalFirstExit({
      position,
      lots: eligibleLots,
      quotesByLotId,
      actualRecoveredProceedsRaw: recovered,
      initialTotalTokenRaw: inputLots.reduce((total, lot) => total + BigInt(lot.quantityRaw), 0n),
      runner,
      nowMs: Date.now(),
      config: {
        recoverPrincipalMultipleBps: CLOCKIN_POLICY_V2.principalRecoveryMultipleBps,
        secondProfitMultipleBps: CLOCKIN_POLICY_V2.secondProfitMultipleBps,
        secondProfitTokenShareBps: CLOCKIN_POLICY_V2.secondProfitTokenShareBps,
        runnerDrawdownBps: CLOCKIN_POLICY_V2.runnerDrawdownBps,
        runnerMaximumHoldingMs: CLOCKIN_POLICY_V2.runnerMaximumHoldingMs,
        momentumFailurePolicyId: CLOCKIN_POLICY_V2.momentumFailurePolicyId,
      },
    });
    const auditIds = new Set(
      store.auditEvents(STRATEGY_ID, identity.launchId).map((e) => e.eventId),
    );
    const policyEventId = `exit-policy:${policy.decisionId}:${head}`;
    if (!auditIds.has(policyEventId)) {
      store.appendAuditEvent({
        eventId: policyEventId,
        eventKind: "EXIT_POLICY_EVALUATED",
        strategyId: STRATEGY_ID,
        launchId: identity.launchId,
        objectId: position.positionId,
        payload: {
          stage: policy.stage,
          trigger: policy.trigger,
          updatedRunnerPeakRaw: policy.updatedRunnerPeakRaw.toString(),
          executableNetLiquidationRaw:
            position.executableNetLiquidationRaw.state === "KNOWN"
              ? position.executableNetLiquidationRaw.value
              : null,
          unvaluedLotIds: aggregated.unvaluedLotIds,
        },
        observedAt: new Date().toISOString(),
      });
    }

    let policyStage: ExitPlan["policyStage"] | null = policy.stage === "HOLD" ? null : policy.stage;
    let instructions = policy.instructions;
    const launchBlock = await canonical.request<{
      readonly timestamp?: unknown;
    } | null>("eth_getBlockByNumber", [quantityToHex(BigInt(identity.blockNumber)), false]);
    if (launchBlock === null || typeof launchBlock.timestamp !== "string") {
      throw new Error("launch block timestamp is unavailable to the exit policy");
    }
    const launchTimestampMs = Number(BigInt(launchBlock.timestamp)) * 1_000;
    const feeWindowClosed =
      Date.now() >= launchTimestampMs + profile.mechanism.decayWindowSeconds * 1_000;
    const liquidation =
      position.executableNetLiquidationRaw.state === "KNOWN"
        ? BigInt(position.executableNetLiquidationRaw.value)
        : null;
    let downside = restoreDownsideState(store, identity);
    if (downside === null && feeWindowClosed && liquidation !== null && liquidation > 0n) {
      downside = Object.freeze({
        positionOpenedAtMs: runner.positionOpenedAtMs,
        postEntryExecutableNetBaselineRaw: liquidation,
        lastCanonicalBlockNumber: null,
        consecutiveBelowStopBlocks: 0,
      });
    }
    if (downside !== null) {
      const decision = decidePrePrincipalDownside({
        actualRecoveredProceedsRaw: recovered,
        actualCostRaw: BigInt(position.totalActualCostRaw),
        executableNetLiquidationRaw: liquidation,
        executableRouteCount: quotesByLotId.size,
        feeWindowClosed,
        canonicalBlockNumber: head,
        nowMs: Date.now(),
        state: downside,
        config: {
          initialStopLossBps: CLOCKIN_POLICY_V2.initialStopLossBps,
          stopLossConfirmationBlocks: CLOCKIN_POLICY_V2.stopLossConfirmationBlocks,
          prePrincipalMaximumHoldingMs: CLOCKIN_POLICY_V2.prePrincipalMaximumHoldingMs,
          noLiquidityPolicy: CLOCKIN_POLICY_V2.noLiquidityPolicy,
        },
      });
      const downsideEventId = `exit-downside:${decision.decisionId}:${head}`;
      if (!auditIds.has(downsideEventId)) {
        store.appendAuditEvent({
          eventId: downsideEventId,
          eventKind: "EXIT_DOWNSIDE_STATE",
          strategyId: STRATEGY_ID,
          launchId: identity.launchId,
          objectId: position.positionId,
          payload: {
            action: decision.action,
            reason: decision.reason,
            positionOpenedAtMs: decision.updatedState.positionOpenedAtMs,
            postEntryExecutableNetBaselineRaw:
              decision.updatedState.postEntryExecutableNetBaselineRaw.toString(),
            lastCanonicalBlockNumber:
              decision.updatedState.lastCanonicalBlockNumber?.toString() ?? null,
            consecutiveBelowStopBlocks: decision.updatedState.consecutiveBelowStopBlocks,
          },
          observedAt: new Date().toISOString(),
        });
      }
      if (decision.action === "EXIT_ALL") {
        policyStage = "EXIT_NOW";
        instructions = allLotInstructions(eligibleLots, quotesByLotId);
      }
      if (decision.action === "ALERT_AND_RETRY_VERIFIED_ROUTES") {
        log("ERROR", "no executable route for an open pre-principal position", {
          launchId: identity.launchId,
          reason: decision.reason,
        });
      }
    }
    if (policyStage === null || instructions.length === 0) return;
    if (
      policyStage === "TAKE_SECOND_PROFIT" &&
      store
        .latestExitPlans(STRATEGY_ID, identity.launchId)
        .some(
          (plan) =>
            plan.policyStage === "TAKE_SECOND_PROFIT" &&
            ["EXECUTING", "UNKNOWN", "PARTIALLY_COMPLETED", "COMPLETED"].includes(plan.state),
        )
    ) {
      return;
    }
    for (const instruction of instructions) {
      const lot = eligibleLots.find((candidate) => candidate.lotId === instruction.lotId);
      const boundQuote = boundByQuoteId.get(instruction.routeQuoteId);
      if (lot === undefined || boundQuote === undefined) continue;
      const pendingPlan = store
        .latestExitPlans(STRATEGY_ID, identity.launchId)
        .find(
          (plan) =>
            plan.lotId === lot.lotId &&
            ["EXECUTING", "UNKNOWN", "DUE", "ARMED"].includes(plan.state),
        );
      if (pendingPlan !== undefined) continue;
      try {
        await executeInstruction({ position, lot, instruction, boundQuote, policyStage, head });
      } catch (error) {
        log("ERROR", "exit instruction failed closed", {
          launchId: identity.launchId,
          lotId: lot.lotId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const tick = async (): Promise<void> => {
    if (working || stopping) return;
    working = true;
    try {
      cleanupAndRenewLeases();
      const head = hexToBigInt(
        "eth_blockNumber",
        await canonical.request<string>("eth_blockNumber"),
      );
      if (head === lastProcessedHead) {
        await writeStatus(
          store.latestOpenPositionLots(STRATEGY_ID).length > 0 ? "ACTIVE" : "READY",
        );
        return;
      }
      lastProcessedHead = head;
      if (Date.now() >= Date.parse(authorization.expiresAt)) {
        await writeStatus("DEGRADED", ["AUTHORIZATION_EXPIRED_EXIT_REQUIRES_RENEWAL"]);
        return;
      }
      const lots = store.latestOpenPositionLots(STRATEGY_ID);
      for (const identity of store.latestLaunchIdentities(STRATEGY_ID)) {
        const launchLots = lots.filter((lot) => lot.launchId === identity.launchId);
        if (launchLots.length > 0) await processLaunch(identity, launchLots, head);
      }
      await writeStatus(lots.length > 0 ? "ACTIVE" : "READY");
    } catch (error) {
      log("ERROR", "exit policy tick failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await writeStatus("DEGRADED", [error instanceof Error ? error.message : String(error)]);
    } finally {
      working = false;
    }
  };

  await writeStatus("READY", [
    "EXIT_ADAPTER_PROFILES_CONFIGURED",
    `FIXED_ROUTES_VERIFIED_${verifiedRouteIds.size}`,
    "EXIT_POLICY_READY",
  ]);
  await watchdog.ready("exit service ready");
  await tick();
  const timer = setInterval(() => void tick(), 1_000);
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    while (working) await new Promise((resolve) => setTimeout(resolve, 25));
    cleanupAndRenewLeases();
    for (const binding of [...activeLeases.values()]) {
      if (!store.walletHasUnresolvedNonce(binding.walletAddress))
        releaseLease(binding.walletAddress);
    }
    await writeStatus("STOPPING", [signal]);
    await watchdog.stopping(`exit service stopping after ${signal}`);
    store.close();
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      service: "clockin-exit",
      state: "FAILED",
      error: error instanceof Error ? error.message : String(error),
      errorId: stableHash(error instanceof Error ? error.message : String(error)),
    })}\n`,
  );
  process.exitCode = 1;
});
