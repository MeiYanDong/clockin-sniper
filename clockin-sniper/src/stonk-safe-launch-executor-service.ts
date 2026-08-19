import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress, isHexString, keccak256 } from "ethers";

import {
  CLOCKIN_APPROVED_LAUNCH_CREATOR,
  CLOCKIN_WETH_SAFE_LAUNCH_PROFILE,
  decodeStonkSafeLaunchQuotedArmed,
  decodeStonkSafeLaunchQuotedCreated,
  minimumReachableStonkSafeLaunchTaxBps,
  SAFE_LAUNCH_BUFFER_TAX_BPS,
  STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
  StonkSafeLaunchQuotedAdapter,
  StonkSafeLaunchQuotedPoolRuntime,
  verifyStonkSafeLaunchQuotedProfile,
  type StonkSafeLaunchQuotedArmed,
  type StonkSafeLaunchQuotedCreated,
  type StonkSafeLaunchQuotedState,
} from "./adapters/stonk-safe-launch-quoted.js";
import { SameRawBroadcaster } from "./broadcast/same-raw-broadcaster.js";
import { CLOCKIN_POLICY_V2 } from "./config/strategy-config.js";
import {
  type Address,
  CanonicalInvariantError,
  type CapitalReservation,
  type ExecutionPlan,
  type EffectRecord,
  type Hex32,
  type LaunchCandidate,
  type LaunchIdentity,
  stableHash,
  type TxAttempt,
  type WalletLane,
} from "./core/canonical.js";
import { assertBoundedCanaryPrincipal } from "./entry/bounded-canary-policy.js";
import { type FeeBandPlan, planTenFeeBands } from "./entry/fee-band-planner.js";
import {
  type LaneDispatchDecision,
  type LaneExecutionState,
  TenLaneOrchestrator,
} from "./entry/lane-orchestrator.js";
import {
  createQuoteSnapshot,
  quoteBoundedMinOut,
  type QuoteSnapshot,
} from "./entry/quote-policy.js";
import { freezeLaunchIdentity } from "./identity/identity-binder.js";
import { OfficialCaMonitor } from "./official-ca-monitor.js";
import {
  SqliteStore,
  type ReleasedPrePlanEntryReservation,
  type ReleasedProvenPreBroadcastEntryReservation,
} from "./persistence/sqlite-store.js";
import {
  assertNoUnresolvedPreparationRecords,
  PreparationRecoveryJournal,
} from "./prepare-stonk-safe-launch-wallets.js";
import { HttpJsonRpcClient } from "./rpc/http-json-rpc.js";
import { quantityToHex } from "./rpc/hex.js";
import type { Hex, JsonRpcRequester } from "./rpc/types.js";
import { parseRpcContractLog, type RawRpcContractLog } from "./rpc/websocket-logs.js";
import { type NewHeadsSubscription, WebSocketNewHeadsClient } from "./rpc/websocket-new-heads.js";
import {
  loadProductionWalletSigners,
  loadStonkSafeLaunchProfileAndAuthorization,
  loadVaultKey,
  readSystemdCredential,
} from "./runtime/credentials.js";
import { evaluateRuntimeIdentityGate } from "./runtime/identity-gate.js";
import { assertPaidRpcApproved } from "./runtime/paid-rpc-approval.js";
import { assertProductionArmApproved } from "./runtime/production-arm-approval.js";
import {
  readCurrentPublicLaunchHandoff,
  type PublicLaunchHandoffRecord,
} from "./runtime/public-launch-handoff.js";
import {
  ProductionSameRawProvider,
  readGenesisHash,
  readNativeBalance,
  readTokenBalance,
} from "./runtime/production-rpc.js";
import {
  inspectExecutorDependencies,
  writeProductionServiceStatus,
} from "./runtime/service-status.js";
import { discoverStonkSafeLaunchClockIn } from "./runtime/stonk-safe-launch-discovery.js";
import {
  assertLaunchWithinProductionBounds,
  type StonkSafeLaunchProductionProfile,
} from "./runtime/stonk-safe-launch-production-profile.js";
import {
  inspectStonkSafeLaunchWalletReadiness,
  type StonkSafeLaunchWalletReadinessRow,
  type StonkSafeLaunchWalletReadinessReport,
} from "./runtime/stonk-safe-launch-wallet-readiness.js";
import { SystemdWatchdog } from "./runtime/systemd-watchdog.js";
import {
  type EntryBroadcastSnapshot,
  parseProductionBroadcastSnapshot,
} from "./runtime/transaction-snapshots.js";
import { SignedTxVault } from "./wallets/signed-tx-vault.js";
import { type NonceSlot, WalletTransactionCoordinator } from "./wallets/transaction-coordinator.js";

export const STONK_SAFE_LAUNCH_STRATEGY_ID = "clockin-mainnet-v1";
const STATUS_DIRECTORY = process.env.CLOCKIN_STATUS_DIR?.trim() || "/run/clockin-status";
const STATE_DIRECTORY = process.env.CLOCKIN_STATE_DIR?.trim() || "/var/lib/clockin-sniper";
const LEASE_TTL_MS = 30_000;
export const SAFE_LAUNCH_ARMED_WAIT_TIMEOUT_MS = 15 * 60 * 1_000;

interface LeaseBinding {
  readonly walletAddress: Address;
  readonly epoch: number;
  active: boolean;
}

interface QuotedLaunchRuntime {
  readonly identity: LaunchIdentity;
  readonly created: StonkSafeLaunchQuotedCreated;
  readonly adapter: StonkSafeLaunchQuotedAdapter;
  readonly pool: StonkSafeLaunchQuotedPoolRuntime;
  readonly launchState: StonkSafeLaunchQuotedState;
  readonly feePlan: FeeBandPlan;
  readonly orchestrator: TenLaneOrchestrator;
  readonly batchWethRaw: bigint;
  canaryExpectedOutputRaw: bigint;
  readonly officialCa: OfficialCaMonitor;
  readonly expiresAtMs: number;
  canaryApplied: boolean;
  canaryEffectConfirmed: boolean;
  laterWalletsReady: boolean;
  reconcilerReady: boolean;
  lastExpansionSummary: string;
}

export interface QuotedEntryPlanDraft
  extends Omit<ExecutionPlan, "planHash" | "state" | "quoteBlock" | "minOutputRaw"> {
  readonly valueRaw: "0";
}

/** ERC20 quoted buys spend calldata quoteIn and must never attach native value. */
export function freezeQuotedEntryPlan(input: {
  readonly draft: QuotedEntryPlanDraft;
  readonly quote: QuoteSnapshot;
  readonly minOutputRaw: bigint;
}): ExecutionPlan {
  if (input.draft.valueRaw !== "0") throw new Error("quoted Safe Launch entry value must be zero");
  if (input.quote.laneId !== input.draft.laneId) throw new Error("quoted entry lane mismatch");
  if (input.quote.profileRevision !== input.draft.mechanismProfileRevision) {
    throw new Error("quoted entry profile revision mismatch");
  }
  if (input.minOutputRaw <= 0n || input.minOutputRaw > input.quote.expectedTokenOutRaw) {
    throw new RangeError("quoted entry minOut is outside its exact-block quote");
  }
  const frozenAt = input.draft.createdAt;
  const canonical = Object.freeze({
    ...input.draft,
    quoteId: input.quote.quoteId,
    quoteRevision: input.quote.revision,
    quoteBlock: input.quote.blockNumber.toString(),
    quoteBlockHash: input.quote.blockHash,
    principalRaw: input.quote.principalRaw.toString(),
    minOutputRaw: input.minOutputRaw.toString(),
  });
  return Object.freeze({
    ...input.draft,
    planHash: stableHash(canonical),
    quoteBlock: input.quote.blockNumber.toString(),
    minOutputRaw: input.minOutputRaw.toString(),
    state: "FROZEN",
    frozenAt,
  });
}

export function dynamicSafeLaunchMechanismId(
  profile: StonkSafeLaunchProductionProfile,
  launch: StonkSafeLaunchQuotedState,
): string {
  return `safe-launch-quoted:${profile.revision}:${launch.startTaxBps}-${launch.decayPerMinuteBps}-${launch.windowSeconds}-${launch.bufferSeconds}`;
}

export function assertArmedLaunchBinding(input: {
  readonly profile: StonkSafeLaunchProductionProfile;
  readonly launch: StonkSafeLaunchQuotedState;
  readonly launchId: bigint;
  readonly tokenAddress: Address;
  readonly armedDeadline: bigint;
}): void {
  assertLaunchWithinProductionBounds(input.profile, input.launch);
  if (
    input.launch.id !== input.launchId ||
    input.launch.tokenAddress.toLowerCase() !== input.tokenAddress.toLowerCase() ||
    input.launch.creatorAddress.toLowerCase() !==
      input.profile.identity.expectedCreator.toLowerCase() ||
    input.launch.deadline !== input.armedDeadline ||
    !input.launch.armed ||
    input.launch.aborted ||
    input.launch.graduated ||
    input.launch.bonded
  ) {
    throw new Error("exact-block LaunchCreated/LaunchArmed state binding is invalid");
  }
}

export function safeLaunchTaxIsBuyable(
  taxBps: number,
  startTaxBps: number,
  minimumReachableTaxBps: number,
): boolean {
  if (
    !Number.isSafeInteger(taxBps) ||
    !Number.isSafeInteger(startTaxBps) ||
    !Number.isSafeInteger(minimumReachableTaxBps)
  ) {
    return false;
  }
  return (
    minimumReachableTaxBps >= 0 &&
    taxBps >= minimumReachableTaxBps &&
    taxBps <= startTaxBps &&
    taxBps !== SAFE_LAUNCH_BUFFER_TAX_BPS
  );
}

export function safeLaunchArmedWaitDeadlineMs(
  handoffObservedAt: string,
  timeoutMs = SAFE_LAUNCH_ARMED_WAIT_TIMEOUT_MS,
): number {
  const observedAtMs = Date.parse(handoffObservedAt);
  if (!Number.isFinite(observedAtMs)) throw new TypeError("handoff observedAt is invalid");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Armed wait timeout must be a positive safe integer");
  }
  return observedAtMs + timeoutMs;
}

export type PaidExecutorLifecycleEndReason =
  | "APPROVAL_REVOKED"
  | "AUTHORIZATION_EXPIRED"
  | "ARMED_TIMEOUT"
  | "LAUNCH_DEADLINE";

export class PaidExecutorLifecycleEnded extends Error {
  readonly reason: PaidExecutorLifecycleEndReason;

  constructor(reason: PaidExecutorLifecycleEndReason, message: string) {
    super(message);
    this.name = "PaidExecutorLifecycleEnded";
    this.reason = reason;
  }
}

export function assertPaidExecutorLifecycleActive(input: {
  readonly ended: PaidExecutorLifecycleEnded | null;
  readonly nowMs: number;
  readonly authorizationExpiresAtMs: number;
  readonly armed: boolean;
  readonly armedWaitDeadlineMs: number;
  readonly launchDeadlineMs: number | null;
  readonly recoveringExpiredArmedState?: boolean;
  readonly stage: string;
}): void {
  if (input.ended !== null) throw input.ended;
  if (input.nowMs >= input.authorizationExpiresAtMs) {
    throw new PaidExecutorLifecycleEnded(
      "AUTHORIZATION_EXPIRED",
      `authorization expired during ${input.stage}`,
    );
  }
  if (
    !input.armed &&
    input.recoveringExpiredArmedState !== true &&
    input.nowMs >= input.armedWaitDeadlineMs
  ) {
    throw new PaidExecutorLifecycleEnded(
      "ARMED_TIMEOUT",
      `LaunchArmed was not observed within the bounded wait during ${input.stage}`,
    );
  }
  if (input.launchDeadlineMs !== null && input.nowMs >= input.launchDeadlineMs) {
    throw new PaidExecutorLifecycleEnded(
      "LAUNCH_DEADLINE",
      `launch deadline reached during ${input.stage}`,
    );
  }
}

/**
 * On restart, the public handoff can be older than the Created-to-Armed wait even though the
 * matching launch is already armed. Perform one bounded canonical HTTP backfill before deciding
 * that the wait expired; the paid WSS discovery subsequently replays and fully binds both events.
 */
export async function recoverCanonicalArmedForPublicHandoff(input: {
  readonly requester: JsonRpcRequester;
  readonly handoff: PublicLaunchHandoffRecord;
}): Promise<StonkSafeLaunchQuotedArmed | null> {
  const fromBlock = BigInt(input.handoff.created.blockNumber);
  const launchId = BigInt(input.handoff.created.launchId);
  const latestRaw = await input.requester.request<string>("eth_blockNumber");
  const latestBlock = rpcQuantity(latestRaw, "latest block number");
  if (latestBlock < fromBlock) {
    throw new CanonicalInvariantError(
      "REORG_DETECTED",
      "canonical head precedes the fixed public LaunchCreated handoff",
    );
  }
  const rawLogs = await input.requester.request<readonly RawRpcContractLog[]>("eth_getLogs", [
    {
      address: CLOCKIN_WETH_SAFE_LAUNCH_PROFILE.factoryAddress,
      topics: [STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC],
      fromBlock: quantityToHex(fromBlock),
      toBlock: quantityToHex(latestBlock),
    },
  ]);
  const matching = rawLogs
    .map((raw) => parseRpcContractLog(input.requester.providerId, raw))
    .map((log) => {
      if (log.removed) {
        throw new CanonicalInvariantError(
          "REORG_DETECTED",
          "canonical Armed backfill returned a removed log",
        );
      }
      return decodeStonkSafeLaunchQuotedArmed(log, CLOCKIN_WETH_SAFE_LAUNCH_PROFILE);
    })
    .filter((event) => event.id === launchId);
  if (matching.length > 1) {
    throw new CanonicalInvariantError(
      "IDENTITY_CONFLICT",
      "multiple LaunchArmed events match the fixed public handoff",
    );
  }
  return matching[0] ?? null;
}

export function evaluateQuotedExpansion(input: {
  readonly canonicalCanaryEffect: boolean;
  readonly strongCreatorPadBinding: boolean;
  readonly allWalletsReady: boolean;
  readonly reconcilerReady: boolean;
}): Readonly<{ ready: boolean; reasons: readonly string[] }> {
  const reasons: string[] = [];
  if (!input.canonicalCanaryEffect) reasons.push("canonical canary effect is pending");
  if (!input.strongCreatorPadBinding)
    reasons.push("strong creator and WETH pad binding is missing");
  if (!input.allWalletsReady) reasons.push("all remaining WETH wallet lanes are not ready");
  if (!input.reconcilerReady) reasons.push("canonical reconciler is not current");
  return Object.freeze({ ready: reasons.length === 0, reasons: Object.freeze(reasons) });
}

interface ReceiptLike {
  readonly blockNumber?: unknown;
  readonly blockHash?: unknown;
  readonly transactionHash?: unknown;
  readonly transactionIndex?: unknown;
  readonly status?: unknown;
  readonly logs?: unknown;
}

interface BlockLike {
  readonly number?: unknown;
  readonly hash?: unknown;
  readonly baseFeePerGas?: unknown;
}

function rpcQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u.test(value)) {
    throw new TypeError(`${label} is not a canonical RPC quantity`);
  }
  return BigInt(value);
}

function hex32(value: unknown, label: string): Hex32 {
  if (typeof value !== "string" || !isHexString(value, 32)) {
    throw new TypeError(`${label} is not a 32-byte hex value`);
  }
  return value as Hex32;
}

const WEI_PER_ETH = 1_000_000_000_000_000_000n;
const USD8_TO_USD_MICROS_SCALE = 100n;

/** Convert the LaunchArmed USD-per-ETH oracle (USD x 1e8) into an exact, at-most-5U WETH input. */
export function wethRawForUsdMicrosAtArmedQuote(
  nominalUsdMicros: bigint,
  quoteUsd8: bigint,
): bigint {
  if (nominalUsdMicros <= 0n || quoteUsd8 <= 0n) {
    throw new RangeError("Armed USD quote and nominal USD principal must be positive");
  }
  const raw = (nominalUsdMicros * 100_000_000_000_000_000_000n) / quoteUsd8;
  if (raw <= 0n) throw new RangeError("Armed USD quote rounds the WETH principal to zero");
  return raw;
}

function weiToUsdMicrosAtArmedQuote(wei: bigint, quoteUsd8: bigint): bigint {
  if (wei < 0n || quoteUsd8 <= 0n) throw new RangeError("Armed risk quantities are invalid");
  const numerator = wei * quoteUsd8;
  const denominator = WEI_PER_ETH * USD8_TO_USD_MICROS_SCALE;
  return (numerator + denominator - 1n) / denominator;
}

export function assertArmedEntryRiskWithinCap(input: {
  readonly quoteUsd8: bigint;
  readonly laneCount: number;
  readonly nominalLaneUsdMicros: bigint;
  readonly gasLimit: bigint;
  readonly maximumFeePerGasWei: bigint;
  readonly allInRiskCapUsdMicros: bigint;
}): Readonly<{ principalUsdMicros: bigint; maximumGasUsdMicros: bigint; totalUsdMicros: bigint }> {
  if (!Number.isSafeInteger(input.laneCount) || input.laneCount <= 0) {
    throw new RangeError("entry lane count must be positive");
  }
  const principalUsdMicros = input.nominalLaneUsdMicros * BigInt(input.laneCount);
  const maximumGasWei = input.gasLimit * input.maximumFeePerGasWei * BigInt(input.laneCount);
  const maximumGasUsdMicros = weiToUsdMicrosAtArmedQuote(maximumGasWei, input.quoteUsd8);
  const totalUsdMicros = principalUsdMicros + maximumGasUsdMicros;
  if (totalUsdMicros > input.allInRiskCapUsdMicros) {
    throw new Error(
      `Armed entry principal plus maximum gas ${totalUsdMicros} USD micros exceeds the ${input.allInRiskCapUsdMicros} all-in cap`,
    );
  }
  return Object.freeze({ principalUsdMicros, maximumGasUsdMicros, totalUsdMicros });
}

export function assertAuthorizedFeeHeadroom(input: {
  readonly baseFeePerGasWei: bigint;
  readonly maximumPriorityFeePerGasWei: bigint;
  readonly maximumFeePerGasWei: bigint;
}): void {
  if (
    input.baseFeePerGasWei < 0n ||
    input.maximumPriorityFeePerGasWei < 0n ||
    input.maximumFeePerGasWei <= 0n
  ) {
    throw new RangeError("fee headroom values are invalid");
  }
  if (input.baseFeePerGasWei + input.maximumPriorityFeePerGasWei > input.maximumFeePerGasWei) {
    throw new LaneReadinessDeferred(
      "current base fee plus priority fee exceeds the owner-authorized maximum fee",
    );
  }
}

export class PublicLaunchHandoffSuperseded extends Error {
  constructor(message = "public LaunchCreated handoff was invalidated or replaced") {
    super(message);
    this.name = "PublicLaunchHandoffSuperseded";
  }
}

export async function assertCurrentPublicHandoffStillActive(input: {
  readonly expected: PublicLaunchHandoffRecord;
  readonly readCurrent?: () => Promise<PublicLaunchHandoffRecord | null>;
}): Promise<void> {
  const current = await (input.readCurrent ?? readCurrentPublicLaunchHandoff)();
  if (current?.handoffId !== input.expected.handoffId) {
    throw new PublicLaunchHandoffSuperseded();
  }
}

/**
 * Run a blocking paid operation only while its immutable public handoff remains current.
 *
 * The systemd path unit cannot retrigger an executor that is already active, so discovery must
 * observe the pointer itself. Polling the strict current reader also catches both a tombstone and
 * an A -> B replacement even when active.signal was written before this process could watch it.
 */
export async function runWhilePublicHandoffIsCurrent<T>(input: {
  readonly expected: PublicLaunchHandoffRecord;
  readonly operation: (signal: AbortSignal) => Promise<T>;
  readonly readCurrent?: () => Promise<PublicLaunchHandoffRecord | null>;
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
}): Promise<T> {
  const pollIntervalMs = input.pollIntervalMs ?? 100;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 5_000) {
    throw new RangeError("public handoff polling interval must be between 10 and 5000ms");
  }
  const readCurrent = input.readCurrent ?? readCurrentPublicLaunchHandoff;
  await assertCurrentPublicHandoffStillActive({
    expected: input.expected,
    readCurrent,
  });

  const operationAbort = new AbortController();
  const operationSignal =
    input.signal === undefined
      ? operationAbort.signal
      : AbortSignal.any([input.signal, operationAbort.signal]);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const superseded = new Promise<never>((_resolve, reject) => {
    const schedule = (): void => {
      timer = setTimeout(() => {
        timer = null;
        void assertCurrentPublicHandoffStillActive({
          expected: input.expected,
          readCurrent,
        })
          .then(() => {
            if (!stopped) schedule();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            stopped = true;
            // Settle the race with the restart-required reason before aborting discovery. This
            // prevents the WSS operation's generic AbortError from hiding the handoff change.
            reject(error);
            operationAbort.abort(error);
          });
      }, pollIntervalMs);
      timer.unref();
    };
    schedule();
  });

  try {
    return await Promise.race([input.operation(operationSignal), superseded]);
  } finally {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    operationAbort.abort();
  }
}

export async function assertFreshCanonicalQuoteAndFee(input: {
  readonly requester: JsonRpcRequester;
  readonly quote: QuoteSnapshot;
  readonly expectedBlockHash: Hex32;
  readonly nowMs: number;
  readonly maximumDriftBps: number;
  readonly maximumFeePerGasWei: bigint;
  readonly maximumPriorityFeePerGasWei: bigint;
}): Promise<void> {
  const [quoteBlock, latestBlock] = await Promise.all([
    input.requester.request<BlockLike | null>("eth_getBlockByNumber", [
      quantityToHex(input.quote.blockNumber),
      false,
    ]),
    input.requester.request<BlockLike | null>("eth_getBlockByNumber", ["latest", false]),
  ]);
  if (quoteBlock === null || latestBlock === null) {
    throw new LaneReadinessDeferred("canonical quote or fee block is unavailable");
  }
  const quoteBlockHash = hex32(quoteBlock.hash, "quote block hash");
  if (quoteBlockHash.toLowerCase() !== input.expectedBlockHash.toLowerCase()) {
    throw new CanonicalInvariantError("REORG_DETECTED", "quoted block is no longer canonical");
  }
  // This validates expiry, exact canonical block binding, and a non-zero bounded output even for
  // the canary. The canary transaction may still retain the separately authorized minOut=1.
  quoteBoundedMinOut(input.quote, input.maximumDriftBps, input.nowMs, input.expectedBlockHash);
  assertAuthorizedFeeHeadroom({
    baseFeePerGasWei: rpcQuantity(latestBlock.baseFeePerGas, "latest base fee"),
    maximumPriorityFeePerGasWei: input.maximumPriorityFeePerGasWei,
    maximumFeePerGasWei: input.maximumFeePerGasWei,
  });
}

export interface PaidExecutorBootstrapHooks<T> {
  readonly readCurrentHandoff: () => Promise<PublicLaunchHandoffRecord | null>;
  readonly assertApprovals: () => Promise<void>;
  readonly loadPaidRuntime: () => Promise<T>;
}

/**
 * The fixed public handoff is the paid executor's first I/O boundary. Marker checks and every
 * paid/signer credential read are deliberately sequenced after a strict handoff parse.
 */
export async function establishPaidExecutorBootstrap<T>(
  hooks: PaidExecutorBootstrapHooks<T>,
): Promise<Readonly<{ handoff: PublicLaunchHandoffRecord; paidRuntime: T }>> {
  const handoff = await hooks.readCurrentHandoff();
  if (handoff === null) throw new Error("current public LaunchCreated handoff is missing");
  await hooks.assertApprovals();
  const paidRuntime = await hooks.loadPaidRuntime();
  return Object.freeze({ handoff, paidRuntime });
}

export function assertDiscoveryMatchesPublicHandoff(
  handoff: PublicLaunchHandoffRecord,
  created: StonkSafeLaunchQuotedCreated,
): void {
  const expected = handoff.created;
  if (
    created.factoryAddress.toLowerCase() !== expected.factoryAddress.toLowerCase() ||
    created.id !== BigInt(expected.launchId) ||
    created.tokenAddress.toLowerCase() !== expected.tokenAddress.toLowerCase() ||
    created.creatorAddress.toLowerCase() !== expected.creatorAddress.toLowerCase() ||
    created.externalToken !== expected.externalToken ||
    created.blockNumber !== BigInt(expected.blockNumber) ||
    created.transactionHash.toLowerCase() !== expected.transactionHash.toLowerCase() ||
    created.logIndex !== BigInt(expected.logIndex)
  ) {
    throw new CanonicalInvariantError(
      "IDENTITY_CONFLICT",
      "paid Safe Launch discovery does not match the fixed public handoff",
    );
  }
}

export function assertCanonicalCreatedMatchesPublicHandoff(
  handoff: PublicLaunchHandoffRecord,
  canonicalCreated: Readonly<{ blockHash: Hex32 }>,
): void {
  if (canonicalCreated.blockHash.toLowerCase() !== handoff.created.blockHash.toLowerCase()) {
    throw new CanonicalInvariantError(
      "REORG_DETECTED",
      "canonical LaunchCreated block hash differs from the fixed public handoff",
    );
  }
}

export async function assertCanonicalSafeLaunchCreated(input: {
  readonly requester: JsonRpcRequester;
  readonly created: StonkSafeLaunchQuotedCreated;
}): Promise<Readonly<{ blockHash: Hex32; transactionIndex: bigint }>> {
  const blockTag = quantityToHex(input.created.blockNumber);
  const [receipt, block] = await Promise.all([
    input.requester.request<ReceiptLike | null>("eth_getTransactionReceipt", [
      input.created.transactionHash,
    ]),
    input.requester.request<BlockLike | null>("eth_getBlockByNumber", [blockTag, false]),
  ]);
  if (receipt === null || block === null) {
    throw new CanonicalInvariantError(
      "REORG_DETECTED",
      "LaunchCreated receipt or block is missing",
    );
  }
  const receiptHash = hex32(receipt.transactionHash, "created receipt transactionHash");
  const receiptBlock = rpcQuantity(receipt.blockNumber, "created receipt blockNumber");
  const receiptBlockHash = hex32(receipt.blockHash, "created receipt blockHash");
  const blockNumber = rpcQuantity(block.number, "created block number");
  const blockHash = hex32(block.hash, "created block hash");
  if (
    receiptHash.toLowerCase() !== input.created.transactionHash.toLowerCase() ||
    receiptBlock !== input.created.blockNumber ||
    blockNumber !== input.created.blockNumber ||
    receiptBlockHash.toLowerCase() !== blockHash.toLowerCase() ||
    rpcQuantity(receipt.status, "created receipt status") !== 1n
  ) {
    throw new CanonicalInvariantError(
      "REORG_DETECTED",
      "LaunchCreated receipt is not the canonical successful creation transaction",
    );
  }
  if (!Array.isArray(receipt.logs)) {
    throw new CanonicalInvariantError("REORG_DETECTED", "LaunchCreated receipt logs are missing");
  }
  const matching = receipt.logs
    .map((raw) => parseRpcContractLog(input.requester.providerId, raw as RawRpcContractLog))
    .filter((log) => log.logIndex === input.created.logIndex);
  if (matching.length !== 1) {
    throw new CanonicalInvariantError(
      "REORG_DETECTED",
      "LaunchCreated receipt does not contain exactly one bound event log",
    );
  }
  const eventLog = matching[0];
  if (eventLog === undefined) {
    throw new CanonicalInvariantError("REORG_DETECTED", "bound LaunchCreated event disappeared");
  }
  const decoded = decodeStonkSafeLaunchQuotedCreated(eventLog);
  if (
    decoded.factoryAddress.toLowerCase() !== input.created.factoryAddress.toLowerCase() ||
    decoded.id !== input.created.id ||
    decoded.tokenAddress.toLowerCase() !== input.created.tokenAddress.toLowerCase() ||
    decoded.creatorAddress.toLowerCase() !== input.created.creatorAddress.toLowerCase() ||
    decoded.externalToken !== input.created.externalToken ||
    decoded.blockNumber !== input.created.blockNumber ||
    decoded.transactionHash.toLowerCase() !== input.created.transactionHash.toLowerCase() ||
    decoded.logIndex !== input.created.logIndex
  ) {
    throw new CanonicalInvariantError(
      "IDENTITY_CONFLICT",
      "canonical LaunchCreated event differs from the bound candidate",
    );
  }
  return Object.freeze({
    blockHash,
    transactionIndex: rpcQuantity(receipt.transactionIndex, "created receipt transactionIndex"),
  });
}

export async function buildCanonicalSafeLaunchIdentity(input: {
  readonly requester: JsonRpcRequester;
  readonly profile: StonkSafeLaunchProductionProfile;
  readonly created: StonkSafeLaunchQuotedCreated;
  readonly metadata: Readonly<{ name: string; symbol: string }>;
  readonly launch: StonkSafeLaunchQuotedState;
  readonly frozenAt: string;
}): Promise<LaunchIdentity> {
  if (
    input.created.creatorAddress.toLowerCase() !== CLOCKIN_APPROVED_LAUNCH_CREATOR.toLowerCase() ||
    input.created.creatorAddress.toLowerCase() !==
      input.profile.identity.expectedCreator.toLowerCase()
  ) {
    throw new Error("Safe Launch creator is not the approved ClockIn wallet");
  }
  if (
    input.metadata.name !== input.profile.identity.expectedName ||
    input.metadata.symbol !== input.profile.identity.expectedSymbol ||
    input.created.externalToken !== input.profile.identity.requirePrimaryExternalToken
  ) {
    throw new Error("Safe Launch token identity differs from the authorized ClockIn identity");
  }
  const blockTag = quantityToHex(input.created.blockNumber);
  const [tokenCode, canonicalCreated] = await Promise.all([
    input.requester.request<string>("eth_getCode", [input.created.tokenAddress, blockTag]),
    assertCanonicalSafeLaunchCreated({ requester: input.requester, created: input.created }),
  ]);
  if (!isHexString(tokenCode) || tokenCode === "0x") {
    throw new Error("ClockIn token runtime code is empty at LaunchCreated block");
  }
  const receiptHash = input.created.transactionHash as Hex32;
  const blockHash = canonicalCreated.blockHash;
  const candidate: LaunchCandidate = Object.freeze({
    candidateId: `safe-launch-candidate:${stableHash({
      transactionHash: input.created.transactionHash,
      logIndex: input.created.logIndex.toString(),
    })}`,
    strategyId: STONK_SAFE_LAUNCH_STRATEGY_ID,
    revision: 1,
    factoryProfileId: input.profile.profileId,
    creator: getAddress(input.created.creatorAddress) as Address,
    tokenAddress: getAddress(input.created.tokenAddress) as Address,
    poolAddress: input.profile.factory.address,
    name: input.metadata.name,
    symbol: input.metadata.symbol,
    metadataUri: "safe-launch://exact-factory-event",
    imageHash: keccak256("0x") as Hex32,
    blockNumber: input.created.blockNumber.toString(),
    blockHash,
    transactionHash: receiptHash,
    transactionIndex: canonicalCreated.transactionIndex.toString(),
    logIndex: input.created.logIndex.toString(),
    evidenceIds: Object.freeze([
      ...input.profile.evidenceIds,
      `launch-created:${receiptHash}:${input.created.logIndex.toString()}`,
      `created-receipt:${receiptHash}:${blockHash}`,
    ]),
    observedAt: input.frozenAt,
  });
  return freezeLaunchIdentity({
    candidate,
    policy: Object.freeze({
      expectedNames: Object.freeze([input.profile.identity.expectedName]),
      expectedSymbols: Object.freeze([input.profile.identity.expectedSymbol]),
      expectedCreators: Object.freeze([input.profile.identity.expectedCreator]),
      metadataIncludes: Object.freeze([]),
      tokenSuffixes: Object.freeze([]),
      requireCreator: true,
      requireMetadata: false,
      requireTokenSuffix: false,
      policyRevision: input.profile.revision,
    }),
    tokenRuntimeCodeHash: keccak256(tokenCode) as Hex32,
    poolRuntimeCodeHash: input.profile.factory.runtimeCodeHash,
    mechanismProfileId: dynamicSafeLaunchMechanismId(input.profile, input.launch),
    configHash: CLOCKIN_POLICY_V2.configHash,
    frozenAt: input.frozenAt,
  });
}

class ProvenPreBroadcastFailure extends Error {}
class LaneReadinessDeferred extends Error {}

/**
 * A quoted lane cannot leave the retryable state without the exact observation's output.
 * Lane 1 is intentionally selectable by the generic orchestrator before a quote exists,
 * so the quoted service must turn that transient gap back into DEFERRED rather than
 * consuming the one-shot canary.
 */
export function requireQuotedLaneExpectedOutput(
  quotes: ReadonlyMap<string, QuoteSnapshot>,
  laneId: string,
): bigint {
  const expected = quotes.get(laneId)?.expectedTokenOutRaw;
  if (expected === undefined) {
    throw new LaneReadinessDeferred(`lane ${laneId} has no current quoted output`);
  }
  return expected;
}

/** Apply the real pre-dispatch state transition without consuming an unquoted lane. */
export function resolveQuotedLaneExpectedOutputForDispatch(input: {
  readonly orchestrator: TenLaneOrchestrator;
  readonly quotes: ReadonlyMap<string, QuoteSnapshot>;
  readonly laneId: string;
}): bigint | null {
  if (!input.quotes.has(input.laneId)) {
    input.orchestrator.deferDispatchedLane(
      input.laneId,
      "QUOTE_UNAVAILABLE: exact-block quoted output is required before dispatch",
    );
    return null;
  }
  return requireQuotedLaneExpectedOutput(input.quotes, input.laneId);
}
class DroppedProvenLaneRetry extends LaneReadinessDeferred {}
export class DeterministicPayloadInvariantFailure extends Error {}

export type PreBroadcastFailureDisposition = "DEFERRED_RETRY" | "FAILED_FINAL";

/**
 * Only a small, explicit set of deterministic invariants may consume a lane.
 * Transport, balance, nonce-readback, SQLite, vault and signer failures are safe
 * pre-broadcast failures and must be retried after their durable ownership is released.
 */
export function classifyPreBroadcastFailure(error: unknown): PreBroadcastFailureDisposition {
  if (error instanceof DeterministicPayloadInvariantFailure) return "FAILED_FINAL";
  if (
    error instanceof CanonicalInvariantError &&
    (error.reasonCode === "BUDGET_EXCEEDED" ||
      error.reasonCode === "IDENTITY_CONFLICT" ||
      error.reasonCode === "AUTHORIZATION_SCOPE_MISMATCH")
  ) {
    return "FAILED_FINAL";
  }
  return "DEFERRED_RETRY";
}

export interface QuotedDispatchIds {
  readonly intentId: string;
  readonly planId: string;
  readonly reservationId: string;
}

/**
 * Recover the only safe no-plan crash window before wallet readiness is evaluated. A persisted
 * execution plan or transaction attempt makes the store method fail closed instead of releasing.
 */
export function recoverQuotedPrePlanOrphans(input: {
  readonly store: SqliteStore;
  readonly launchId: string;
  readonly ownerId: string;
  readonly recoveredAt: string;
}): readonly ReleasedPrePlanEntryReservation[] {
  return input.store.releaseOrphanedPrePlanEntryReservations(
    STONK_SAFE_LAUNCH_STRATEGY_ID,
    input.launchId,
    input.ownerId,
    input.recoveredAt,
  );
}

export function recoverQuotedProvenPreBroadcastOrphans(input: {
  readonly store: SqliteStore;
  readonly launchId: string;
  readonly ownerId: string;
  readonly recoveredAt: string;
}): readonly ReleasedProvenPreBroadcastEntryReservation[] {
  return input.store.releaseProvenPreBroadcastEntryReservations(
    STONK_SAFE_LAUNCH_STRATEGY_ID,
    input.launchId,
    input.ownerId,
    input.recoveredAt,
  );
}

/** Keep the business intent stable while every observed-block retry gets fresh durable IDs. */
export function buildQuotedDispatchIds(input: {
  readonly launchId: string;
  readonly laneId: string;
  readonly walletAddress: Address;
  readonly nonce: bigint;
  readonly observationId: string;
  readonly blockNumber: bigint;
  readonly blockHash: Hex32;
}): QuotedDispatchIds {
  const intentId = `entry-intent:${stableHash({
    launchId: input.launchId,
    laneId: input.laneId,
    wallet: input.walletAddress,
  })}`;
  const attemptKey = stableHash({
    intentId,
    nonce: input.nonce.toString(),
    observationId: input.observationId,
    blockNumber: input.blockNumber.toString(),
    blockHash: input.blockHash,
  });
  return Object.freeze({
    intentId,
    planId: `entry-plan:${attemptKey}`,
    reservationId: `entry-reservation:${attemptKey}`,
  });
}

export function quotedEntryEnabled(input: {
  readonly stopping: boolean;
  readonly authorizationValid: boolean;
  readonly remainingWalletAddresses: readonly Address[];
  readonly activeLeaseAddresses: readonly Address[];
}): boolean {
  if (input.stopping || !input.authorizationValid || input.remainingWalletAddresses.length === 0) {
    return false;
  }
  const active = new Set(input.activeLeaseAddresses.map((address) => address.toLowerCase()));
  return input.remainingWalletAddresses.every((address) => active.has(address.toLowerCase()));
}

export type QuotedLaneRecoveryState = Extract<
  LaneExecutionState,
  "WAITING" | "DISPATCHED" | "UNKNOWN" | "FAILED_FINAL" | "EFFECT_CONFIRMED"
>;

export interface QuotedLaneRecovery {
  readonly laneId: string;
  readonly walletAddress: Address;
  readonly state: QuotedLaneRecoveryState;
  readonly sourcePlan?: ExecutionPlan;
  readonly sourceAttempt?: TxAttempt;
  readonly sourceEffect?: EffectRecord;
}

function assertRecoveryBinding(
  laneId: string,
  walletAddress: Address,
  plan: ExecutionPlan | undefined,
  attempt: TxAttempt | undefined,
): Readonly<{ plan: ExecutionPlan; attempt: TxAttempt }> {
  if (plan === undefined || attempt === undefined) {
    throw new CanonicalInvariantError(
      "EVIDENCE_INCOMPLETE",
      `lane ${laneId} recovery is missing its plan or attempt`,
    );
  }
  if (
    plan.planId !== attempt.planId ||
    plan.laneId !== laneId ||
    attempt.laneId !== laneId ||
    plan.walletAddress.toLowerCase() !== walletAddress.toLowerCase() ||
    attempt.walletAddress.toLowerCase() !== walletAddress.toLowerCase() ||
    plan.nonce !== attempt.nonce
  ) {
    throw new CanonicalInvariantError(
      "NONCE_CONFLICT",
      `lane ${laneId} recovery plan, attempt, wallet or nonce is inconsistent`,
    );
  }
  return Object.freeze({ plan, attempt });
}

/**
 * Reconstruct one lane before applying any current funding check. A canonical effect always wins;
 * provisional/disputed effects fence the lane as UNKNOWN and are left to the reconciler.
 */
export function selectQuotedLaneRecovery(input: {
  readonly laneId: string;
  readonly walletAddress: Address;
  readonly plans: readonly ExecutionPlan[];
  readonly attempts: readonly TxAttempt[];
  readonly effects: readonly EffectRecord[];
}): QuotedLaneRecovery {
  const plans = input.plans.filter((plan) => plan.laneId === input.laneId);
  const attempts = input.attempts.filter((attempt) => attempt.laneId === input.laneId);
  const effects = input.effects.filter((effect) => effect.laneId === input.laneId);
  const canonicalTerminalEffects = effects.filter(
    (effect) =>
      effect.canonicality === "CANONICAL" &&
      (effect.result === "SUCCESS" ||
        effect.result === "REVERTED" ||
        effect.result === "SUCCESS_NO_TOKENS"),
  );
  if (canonicalTerminalEffects.length > 1) {
    throw new CanonicalInvariantError(
      "STATE_TRANSITION_INVALID",
      `lane ${input.laneId} has multiple canonical terminal effects`,
    );
  }
  const canonicalEffect = canonicalTerminalEffects[0];
  if (canonicalEffect !== undefined) {
    const selectedAttempt = attempts.find(
      (candidate) => candidate.attemptId === canonicalEffect.attemptId,
    );
    const selectedPlan = plans.find((candidate) => candidate.planId === selectedAttempt?.planId);
    const { plan, attempt } = assertRecoveryBinding(
      input.laneId,
      input.walletAddress,
      selectedPlan,
      selectedAttempt,
    );
    if (
      canonicalEffect.txHash.toLowerCase() !== attempt.signedTxHash.toLowerCase() ||
      (canonicalEffect.result === "SUCCESS" && attempt.state !== "CONFIRMED_SUCCESS") ||
      (canonicalEffect.result === "SUCCESS_NO_TOKENS" && attempt.state !== "CONFIRMED_SUCCESS") ||
      (canonicalEffect.result === "REVERTED" && attempt.state !== "CONFIRMED_REVERTED")
    ) {
      throw new CanonicalInvariantError(
        "STATE_TRANSITION_INVALID",
        `lane ${input.laneId} canonical effect does not match its confirmed attempt`,
      );
    }
    return Object.freeze({
      laneId: input.laneId,
      walletAddress: input.walletAddress,
      state: canonicalEffect.result === "SUCCESS" ? "EFFECT_CONFIRMED" : "FAILED_FINAL",
      sourcePlan: plan,
      sourceAttempt: attempt,
      sourceEffect: canonicalEffect,
    });
  }

  const unresolvedEffect = effects.at(-1);
  if (unresolvedEffect !== undefined) {
    const selectedAttempt = attempts.find(
      (candidate) => candidate.attemptId === unresolvedEffect.attemptId,
    );
    const selectedPlan = plans.find((candidate) => candidate.planId === selectedAttempt?.planId);
    const { plan, attempt } = assertRecoveryBinding(
      input.laneId,
      input.walletAddress,
      selectedPlan,
      selectedAttempt,
    );
    if (unresolvedEffect.txHash.toLowerCase() !== attempt.signedTxHash.toLowerCase()) {
      throw new CanonicalInvariantError(
        "STATE_TRANSITION_INVALID",
        `lane ${input.laneId} non-canonical effect hash conflicts with its attempt`,
      );
    }
    return Object.freeze({
      laneId: input.laneId,
      walletAddress: input.walletAddress,
      state: "UNKNOWN",
      sourcePlan: plan,
      sourceAttempt: attempt,
      sourceEffect: unresolvedEffect,
    });
  }

  const nonDropped = attempts.filter((attempt) => attempt.state !== "DROPPED_PROVEN");
  if (nonDropped.length > 1) {
    throw new CanonicalInvariantError(
      "STATE_TRANSITION_INVALID",
      `lane ${input.laneId} has multiple non-dropped attempts without an effect`,
    );
  }
  const attempt = nonDropped[0];
  if (attempt === undefined) {
    return Object.freeze({
      laneId: input.laneId,
      walletAddress: input.walletAddress,
      state: "WAITING",
    });
  }
  const selectedPlan = plans.find((candidate) => candidate.planId === attempt.planId);
  const { plan } = assertRecoveryBinding(input.laneId, input.walletAddress, selectedPlan, attempt);
  if (attempt.state === "CONFIRMED_SUCCESS" || attempt.state === "CONFIRMED_REVERTED") {
    throw new CanonicalInvariantError(
      "EVIDENCE_INCOMPLETE",
      `lane ${input.laneId} has a terminal attempt without its canonical effect`,
    );
  }
  return Object.freeze({
    laneId: input.laneId,
    walletAddress: input.walletAddress,
    state:
      attempt.state === "UNKNOWN" || attempt.state === "EXPIRED_UNRESOLVED"
        ? "UNKNOWN"
        : "DISPATCHED",
    sourcePlan: plan,
    sourceAttempt: attempt,
  });
}

/** Current WETH may be spent on terminal lanes; nonce/effect truth must still match exactly. */
export function assertQuotedLaneRecoveryReadiness(input: {
  readonly recovery: QuotedLaneRecovery;
  readonly readiness: StonkSafeLaunchWalletReadinessRow;
  readonly hasUnresolvedPersistentNonce: boolean;
}): void {
  const { recovery, readiness } = input;
  if (
    readiness.address.toLowerCase() !== recovery.walletAddress.toLowerCase() ||
    readiness.walletId.trim().length === 0
  ) {
    throw new CanonicalInvariantError(
      "IDENTITY_CONFLICT",
      `lane ${recovery.laneId} readiness belongs to a different wallet`,
    );
  }
  if (recovery.state === "WAITING") {
    if (!readiness.ready || input.hasUnresolvedPersistentNonce) {
      throw new Error(
        `remaining lane ${recovery.laneId} requires WETH, allowance, gas and a clean nonce`,
      );
    }
    return;
  }

  const attempt = recovery.sourceAttempt;
  const plan = recovery.sourcePlan;
  if (attempt === undefined || plan === undefined) {
    throw new CanonicalInvariantError(
      "EVIDENCE_INCOMPLETE",
      `restored lane ${recovery.laneId} has no durable attempt binding`,
    );
  }
  const attemptNonce = BigInt(attempt.nonce);
  if (recovery.state === "EFFECT_CONFIRMED" || recovery.state === "FAILED_FINAL") {
    if (
      !readiness.eoaReady ||
      input.hasUnresolvedPersistentNonce ||
      readiness.latestNonce !== readiness.pendingNonce ||
      readiness.latestNonce !== attemptNonce + 1n
    ) {
      throw new CanonicalInvariantError(
        "NONCE_CONFLICT",
        `terminal lane ${recovery.laneId} canonical effect and current nonce are inconsistent`,
      );
    }
    return;
  }

  const truthStillPending =
    attempt.state !== "CONFIRMED_SUCCESS" && attempt.state !== "CONFIRMED_REVERTED";
  if (truthStillPending && !input.hasUnresolvedPersistentNonce) {
    throw new CanonicalInvariantError(
      "NONCE_CONFLICT",
      `pending lane ${recovery.laneId} lost durable nonce ownership`,
    );
  }
}

export function quotedRemainingLanesReady(input: {
  readonly lanes: readonly Readonly<{
    walletId: string;
    state: LaneExecutionState;
  }>[];
  readonly readinessRows: readonly StonkSafeLaunchWalletReadinessRow[];
  readonly unresolvedWalletAddresses: readonly Address[];
}): boolean {
  const rows = new Map(input.readinessRows.map((row) => [row.walletId, row] as const));
  const unresolved = new Set(
    input.unresolvedWalletAddresses.map((address) => address.toLowerCase()),
  );
  return input.lanes
    .filter(
      (lane) =>
        lane.state === "WAITING" ||
        lane.state === "DEFERRED" ||
        lane.state === "INCOMPATIBLE_5U_CAP",
    )
    .every((lane) => {
      const row = rows.get(lane.walletId);
      return row?.ready === true && !unresolved.has(row.address.toLowerCase());
    });
}

function revisePlan(
  plan: ExecutionPlan,
  state: Extract<ExecutionPlan["state"], "SIGNED" | "INVALIDATED">,
): ExecutionPlan {
  return Object.freeze({ ...plan, revision: plan.revision + 1, state });
}

function transportState(state: "ACCEPTED" | "KNOWN" | "UNKNOWN" | "REJECTED"): TxAttempt["state"] {
  if (state === "ACCEPTED" || state === "KNOWN") return "ACCEPTED";
  return state === "UNKNOWN" ? "UNKNOWN" : "DROPPED_PROVEN";
}

function log(kind: "INFO" | "ACTION" | "ERROR", message: string, details: object = {}): void {
  process.stdout.write(
    `${JSON.stringify({ service: "clockin-safe-launch-executor", kind, message, ...details })}\n`,
  );
}

function expiry(nowMs: number, ttlMs: number): string {
  return new Date(nowMs + ttlMs).toISOString();
}

/** Production entry point. It is intentionally not invoked when this module is imported by tests. */
export async function runStonkSafeLaunchExecutorService(): Promise<void> {
  const bootstrap = await establishPaidExecutorBootstrap({
    readCurrentHandoff: () => readCurrentPublicLaunchHandoff(),
    assertApprovals: async () => {
      await Promise.all([assertPaidRpcApproved(), assertProductionArmApproved()]);
    },
    loadPaidRuntime: async () => {
      const [walletBundle, rpcHttp, rpcWss, sequencerHttp, vaultKey] = await Promise.all([
        loadProductionWalletSigners(),
        readSystemdCredential("rpc_http"),
        readSystemdCredential("rpc_wss"),
        readSystemdCredential("sequencer_http"),
        loadVaultKey(),
      ]);
      const { profile, authorization } = await loadStonkSafeLaunchProfileAndAuthorization(
        walletBundle.manifest,
      );
      return Object.freeze({
        walletBundle,
        rpcHttp,
        rpcWss,
        sequencerHttp,
        vaultKey,
        profile,
        authorization,
      });
    },
  });
  const { handoff } = bootstrap;
  const { walletBundle, rpcHttp, rpcWss, sequencerHttp, vaultKey, profile, authorization } =
    bootstrap.paidRuntime;
  const authorizationExpiresAtMs = Date.parse(authorization.expiresAt);
  const armedWaitDeadlineMs = safeLaunchArmedWaitDeadlineMs(handoff.observedAt);
  const ownerId =
    process.env.CLOCKIN_EXECUTOR_ID?.trim() || `clockin-safe-launch-executor:${hostname()}`;
  const watchdog = new SystemdWatchdog();
  const shutdown = new AbortController();
  let stopping = false;
  let sequence = 0;
  let currentLaunch: QuotedLaunchRuntime | null = null;
  let headsSubscription: NewHeadsSubscription | null = null;
  let leaseTimer: NodeJS.Timeout | null = null;
  let statusTimer: NodeJS.Timeout | null = null;
  let approvalTimer: NodeJS.Timeout | null = null;
  let authorizationTimer: NodeJS.Timeout | null = null;
  let armedWaitTimer: NodeJS.Timeout | null = null;
  let launchDeadlineTimer: NodeJS.Timeout | null = null;
  let approvalCheckInFlight = false;
  let armed = false;
  let recoveringExpiredArmedState = true;
  let launchDeadlineMs: number | null = null;
  let lifecycleEnd: PaidExecutorLifecycleEnded | null = null;
  const currentLifecycleEnd = (): PaidExecutorLifecycleEnded | null => lifecycleEnd;

  const endPaidLifecycle = (
    reason: PaidExecutorLifecycleEndReason,
    message: string,
  ): PaidExecutorLifecycleEnded => {
    if (lifecycleEnd !== null) return lifecycleEnd;
    lifecycleEnd = new PaidExecutorLifecycleEnded(reason, message);
    log(reason === "LAUNCH_DEADLINE" ? "INFO" : "ERROR", message, { reason });
    shutdown.abort();
    headsSubscription?.close();
    currentLaunch?.officialCa.stop();
    return lifecycleEnd;
  };

  const assertLifecycleActive = (stage: string): void => {
    try {
      assertPaidExecutorLifecycleActive({
        ended: lifecycleEnd,
        nowMs: Date.now(),
        authorizationExpiresAtMs,
        armed,
        armedWaitDeadlineMs,
        launchDeadlineMs,
        recoveringExpiredArmedState,
        stage,
      });
    } catch (error) {
      if (error instanceof PaidExecutorLifecycleEnded) {
        throw endPaidLifecycle(error.reason, error.message);
      }
      throw error;
    }
  };

  const revokeRuntimeApprovals = (error: unknown): void => {
    endPaidLifecycle(
      "APPROVAL_REVOKED",
      `runtime approval marker revoked; aborting discovery and heads: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  };

  const assertLiveApprovals = async (): Promise<void> => {
    await Promise.all([assertPaidRpcApproved(), assertProductionArmApproved()]);
  };

  approvalTimer = setInterval(() => {
    if (approvalCheckInFlight || lifecycleEnd !== null || stopping) return;
    approvalCheckInFlight = true;
    void assertLiveApprovals()
      .catch((error: unknown) => revokeRuntimeApprovals(error))
      .finally(() => {
        approvalCheckInFlight = false;
      });
  }, 250);
  approvalTimer.unref();
  const scheduleLifecycleDeadline = (
    deadlineMs: number,
    reason: Extract<
      PaidExecutorLifecycleEndReason,
      "AUTHORIZATION_EXPIRED" | "ARMED_TIMEOUT" | "LAUNCH_DEADLINE"
    >,
    message: string,
  ): NodeJS.Timeout => {
    const timer = setTimeout(
      () => endPaidLifecycle(reason, message),
      Math.max(0, deadlineMs - Date.now()),
    );
    timer.unref();
    return timer;
  };
  authorizationTimer = scheduleLifecycleDeadline(
    authorizationExpiresAtMs,
    "AUTHORIZATION_EXPIRED",
    "production authorization expired; aborting discovery and heads",
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
  const preparationJournal = new PreparationRecoveryJournal(
    join(STATE_DIRECTORY, "weth-preparation-recovery"),
  );
  const coordinator = new WalletTransactionCoordinator(store);
  const leases: LeaseBinding[] = [];

  const writeStatus = async (
    state: "BOOTING" | "WATCHING" | "READY" | "ACTIVE" | "DEGRADED" | "STOPPING" | "FAILED",
    details: readonly string[] = [],
  ): Promise<void> => {
    sequence += 1;
    const now = new Date().toISOString();
    const activeLeases = leases.filter((binding) => binding.active);
    const remainingWalletAddresses =
      currentLaunch === null
        ? walletBundle.manifest.entries.map((entry) => entry.address)
        : currentLaunch.orchestrator
            .snapshot()
            .filter(
              (lane) =>
                lane.state === "WAITING" ||
                lane.state === "DEFERRED" ||
                lane.state === "INCOMPATIBLE_5U_CAP",
            )
            .map((lane) => {
              const entry = walletBundle.manifest.entries.find(
                (candidate) => candidate.walletId === lane.walletId,
              );
              if (entry === undefined) throw new Error(`lane ${lane.laneId} has no wallet entry`);
              return entry.address;
            });
    const leaseOwned =
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
        leaseOwned,
      }),
      entryEnabled: quotedEntryEnabled({
        stopping,
        authorizationValid: Date.now() < Date.parse(authorization.expiresAt),
        remainingWalletAddresses,
        activeLeaseAddresses: activeLeases.map((binding) => binding.walletAddress),
      }),
      exitEnabled: false,
      unresolvedAttemptCount: store.unresolvedTxAttempts(STONK_SAFE_LAUNCH_STRATEGY_ID).length,
      openPositionCount: store.latestOpenPositionLots(STONK_SAFE_LAUNCH_STRATEGY_ID).length,
      verifiedExitRouteCount: 0,
      details: Object.freeze([
        ...details,
        `ACTIVE_WALLET_LEASES_${activeLeases.length}`,
        "WETH_PREWRAPPED_PREAPPROVED",
        "NO_EXIT_DEPENDENCY_FOR_ENTRY_EXPANSION",
      ]),
    });
  };

  assertLifecycleActive("before profile verification");
  await verifyStonkSafeLaunchQuotedProfile(canonical, CLOCKIN_WETH_SAFE_LAUNCH_PROFILE, "latest");
  assertLifecycleActive("after profile verification");
  await assertNoUnresolvedPreparationRecords(preparationJournal);
  assertLifecycleActive("after preparation recovery gate");
  let readiness: StonkSafeLaunchWalletReadinessReport;
  let readinessByWalletId = new Map<string, StonkSafeLaunchWalletReadinessRow>();
  const leaseByAddress = new Map<string, LeaseBinding>();

  const dependencyInput = Object.freeze({
    directory: STATUS_DIRECTORY,
    profileHash: profile.profileHash,
    authorizationId: authorization.authorizationId,
    expectedSignerCount: walletBundle.signers.length,
  });
  let startupDependencies = await inspectExecutorDependencies(dependencyInput);
  assertLifecycleActive("after reconciler dependency verification");

  if (Date.now() >= armedWaitDeadlineMs) {
    const recoveredArmed = await recoverCanonicalArmedForPublicHandoff({
      requester: canonical,
      handoff,
    });
    recoveringExpiredArmedState = false;
    if (recoveredArmed === null) {
      assertLifecycleActive("after expired Armed canonical backfill");
      throw new Error("expired Armed canonical backfill ended without a lifecycle decision");
    }
    armed = true;
    launchDeadlineMs = Number(recoveredArmed.deadline) * 1_000;
    launchDeadlineTimer = scheduleLifecycleDeadline(
      launchDeadlineMs,
      "LAUNCH_DEADLINE",
      "recovered launch deadline reached; aborting discovery and heads",
    );
    assertLifecycleActive("after expired Armed canonical backfill");
    log("INFO", "recovered existing LaunchArmed before applying the Created wait timeout", {
      launchId: recoveredArmed.id.toString(),
      armedBlock: recoveredArmed.blockNumber.toString(),
      launchDeadline: recoveredArmed.deadline.toString(),
    });
  } else {
    recoveringExpiredArmedState = false;
    armedWaitTimer = scheduleLifecycleDeadline(
      armedWaitDeadlineMs,
      "ARMED_TIMEOUT",
      "LaunchArmed wait exceeded 15 minutes from public LaunchCreated handoff",
    );
    assertLifecycleActive("before bounded live Armed wait");
  }

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
  assertLifecycleActive("after broadcaster preflight");

  const signerByWalletId = new Map(
    walletBundle.signers.map((binding) => [binding.entry.walletId, binding] as const),
  );

  const releaseEligibleLeases = (windowExpired: boolean): void => {
    const terminalWallets = new Set(
      currentLaunch === null
        ? []
        : currentLaunch.orchestrator
            .snapshot()
            .filter(
              (lane) =>
                lane.state === "EFFECT_CONFIRMED" ||
                lane.state === "FAILED_FINAL" ||
                lane.state === "EXPIRED",
            )
            .map((lane) => {
              const entry = walletBundle.manifest.entries.find(
                (candidate) => candidate.walletId === lane.walletId,
              );
              return entry?.address.toLowerCase();
            })
            .filter((address): address is string => address !== undefined),
    );
    for (const binding of leases) {
      if (!binding.active || store.walletHasUnresolvedNonce(binding.walletAddress)) continue;
      if (!windowExpired && !terminalWallets.has(binding.walletAddress.toLowerCase())) continue;
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
    for (const binding of leases) {
      if (!binding.active) continue;
      store.renewServiceLease(
        `wallet:${binding.walletAddress.toLowerCase()}`,
        ownerId,
        binding.epoch,
        expiry(Date.parse(now), LEASE_TTL_MS),
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
  statusTimer = setInterval(() => {
    void writeStatus(currentLaunch === null ? "WATCHING" : "ACTIVE").catch(() => undefined);
  }, 5_000);
  statusTimer.unref();
  await writeStatus("WATCHING", ["EXACT_WETH_SAFE_LAUNCH_PAD"]);
  await watchdog.ready("quoted Safe Launch executor verified and watching exact WETH pad");

  const dispatchLane = async (
    runtime: QuotedLaunchRuntime,
    decision: LaneDispatchDecision,
    blockHash: Hex32,
    blockNumber: bigint,
    expectedTokenOutRaw: bigint,
  ): Promise<void> => {
    assertLifecycleActive(`before dispatching ${decision.laneId}`);
    let reservation: CapitalReservation | null = null;
    let slot: NonceSlot | null = null;
    let plan: ExecutionPlan | null = null;
    let attempt: TxAttempt | null = null;
    let vaultRef: string | null = null;
    let possiblySubmitted = false;
    try {
      const dependencies = await inspectExecutorDependencies(dependencyInput);
      if (!dependencies.canaryReady) {
        throw new LaneReadinessDeferred(
          `canonical reconciler changed before signing: ${dependencies.canaryReasons.join("; ")}`,
        );
      }
      const signerBinding = signerByWalletId.get(decision.walletId);
      const walletReadiness = readinessByWalletId.get(decision.walletId);
      if (signerBinding === undefined || walletReadiness === undefined) {
        throw new Error(`lane ${decision.laneId} has no signer/readiness binding`);
      }
      const lease = leaseByAddress.get(signerBinding.entry.address.toLowerCase());
      if (lease === undefined || !lease.active) throw new Error("wallet lease is inactive");
      const [spend, latestNonceRaw, pendingNonceRaw, nativeBalance] = await Promise.all([
        runtime.adapter.spendReadiness(
          signerBinding.entry.address,
          decision.principalRaw,
          blockNumber,
        ),
        canonical.request<string>("eth_getTransactionCount", [
          signerBinding.entry.address,
          "latest",
        ]),
        canonical.request<string>("eth_getTransactionCount", [
          signerBinding.entry.address,
          "pending",
        ]),
        readNativeBalance(canonical, signerBinding.entry.address, blockNumber),
      ]);
      const latestNonce = rpcQuantity(latestNonceRaw, "latest nonce");
      const pendingNonce = rpcQuantity(pendingNonceRaw, "pending nonce");
      if (!spend.ready) throw new LaneReadinessDeferred("exact-block WETH spend readiness failed");
      if (
        latestNonce !== pendingNonce ||
        pendingNonce !== walletReadiness.pendingNonce ||
        nativeBalance < walletReadiness.requiredNativeGasWei
      ) {
        throw new LaneReadinessDeferred("wallet nonce or native gas readiness changed");
      }
      const now = new Date().toISOString();
      const dispatchIds = buildQuotedDispatchIds({
        launchId: runtime.identity.launchId,
        laneId: decision.laneId,
        walletAddress: signerBinding.entry.address,
        nonce: pendingNonce,
        observationId: decision.observationId,
        blockNumber,
        blockHash,
      });
      const { intentId, planId } = dispatchIds;
      coordinator.claimEntryIntent({
        strategyId: STONK_SAFE_LAUNCH_STRATEGY_ID,
        launchId: runtime.identity.launchId,
        walletAddress: signerBinding.entry.address,
        intentId,
        createdAt: now,
      });
      if (decision.trancheNumber === 1) {
        assertBoundedCanaryPrincipal(CLOCKIN_POLICY_V2.nominalLaneUsdMicros);
      }
      reservation = Object.freeze({
        reservationId: dispatchIds.reservationId,
        strategyId: STONK_SAFE_LAUNCH_STRATEGY_ID,
        revision: 1,
        budgetId: `${runtime.identity.launchId}:budget`,
        launchId: runtime.identity.launchId,
        laneId: decision.laneId,
        intentId,
        configHash: CLOCKIN_POLICY_V2.configHash,
        principalRaw: CLOCKIN_POLICY_V2.nominalLaneUsdMicros.toString(),
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
        pendingNonce,
        "ENTRY",
        planId,
        now,
      );
      const quote = createQuoteSnapshot({
        laneId: decision.laneId,
        poolObservationId: decision.observationId,
        profileRevision: profile.revision,
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
      if (decision.trancheNumber === 1) runtime.canaryExpectedOutputRaw = expectedTokenOutRaw;
      let template: Readonly<{
        adapterId: string;
        target: Address;
        valueRaw: bigint;
        calldata: Hex;
      }>;
      try {
        template = Object.freeze({
          adapterId: runtime.pool.adapterId,
          target: profile.factory.address,
          valueRaw: 0n,
          calldata: runtime.adapter.buildBuy(
            runtime.launchState.id,
            decision.principalRaw,
            minOutputRaw,
            profile.entry.refCode,
          ),
        });
      } catch (error) {
        throw new DeterministicPayloadInvariantFailure(
          `quoted buy payload invariant failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const draft: QuotedEntryPlanDraft = {
        planId,
        strategyId: STONK_SAFE_LAUNCH_STRATEGY_ID,
        revision: 1,
        intentId,
        launchId: runtime.identity.launchId,
        laneId: decision.laneId,
        validityEnvelopeId: `validity:${runtime.identity.launchId}`,
        authorizationId: authorization.authorizationId,
        factoryProfileRevision: profile.revision,
        mechanismProfileRevision: profile.revision,
        adapterId: template.adapterId,
        walletAddress: signerBinding.entry.address,
        nonce: pendingNonce.toString(),
        to: template.target,
        valueRaw: "0",
        calldataHash: keccak256(template.calldata),
        methodSelector: template.calldata.slice(0, 10) as Hex,
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
      };
      try {
        plan = freezeQuotedEntryPlan({ draft, quote, minOutputRaw });
      } catch (error) {
        throw new DeterministicPayloadInvariantFailure(
          `quoted entry plan invariant failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      store.saveExecutionPlan(plan);
      const [principalBefore, tokenBefore] = await Promise.all([
        readTokenBalance(canonical, profile.quote.asset, signerBinding.entry.address, blockNumber),
        readTokenBalance(
          canonical,
          runtime.identity.tokenAddress,
          signerBinding.entry.address,
          blockNumber,
        ),
      ]);
      if (pendingNonce > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError("wallet nonce exceeds signer transaction API range");
      }
      assertLifecycleActive(`before canonical pre-sign check for ${decision.laneId}`);
      const canonicalCreated = await assertCanonicalSafeLaunchCreated({
        requester: canonical,
        created: runtime.created,
      });
      assertCanonicalCreatedMatchesPublicHandoff(handoff, canonicalCreated);
      await assertFreshCanonicalQuoteAndFee({
        requester: canonical,
        quote,
        expectedBlockHash: blockHash,
        nowMs: Date.now(),
        maximumDriftBps: profile.entry.laterLaneMaximumDriftBps,
        maximumFeePerGasWei: BigInt(profile.entry.maximumFeePerGasWei),
        maximumPriorityFeePerGasWei: BigInt(profile.entry.maximumPriorityFeePerGasWei),
      });
      await assertCurrentPublicHandoffStillActive({ expected: handoff });
      // No awaited canonical RPC follows this revocation check before local signing starts.
      try {
        await assertLiveApprovals();
      } catch (error) {
        revokeRuntimeApprovals(error);
        throw error;
      }
      assertLifecycleActive(`before signing ${decision.laneId}`);
      const raw = (await signerBinding.signer.signTransaction({
        chainId: 4_663,
        type: 2,
        nonce: Number(pendingNonce),
        to: template.target,
        value: 0n,
        data: template.calldata,
        gasLimit: BigInt(profile.entry.gasLimit),
        maxFeePerGas: BigInt(profile.entry.maximumFeePerGasWei),
        maxPriorityFeePerGas: BigInt(profile.entry.maximumPriorityFeePerGasWei),
      })) as Hex;
      const txHash = keccak256(raw) as Hex32;
      vaultRef = await vault.put(raw, now);
      slot = coordinator.transition(slot, "SIGNED", now);
      plan = revisePlan(plan, "SIGNED");
      store.saveExecutionPlan(plan);
      const attemptId = `tx-attempt:${stableHash({ planId, txHash })}`;
      attempt = Object.freeze({
        attemptId,
        strategyId: STONK_SAFE_LAUNCH_STRATEGY_ID,
        revision: 1,
        intentId,
        planId,
        launchId: runtime.identity.launchId,
        laneId: decision.laneId,
        walletAddress: signerBinding.entry.address,
        nonce: pendingNonce.toString(),
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
        strategyId: STONK_SAFE_LAUNCH_STRATEGY_ID,
        launchId: runtime.identity.launchId,
        objectId: attemptId,
        payload: {
          formatVersion: 1,
          kind: "ENTRY_BUY",
          principalAsset: profile.quote.asset,
          principalAssetKind: "ERC20",
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
      try {
        await assertLiveApprovals();
      } catch (error) {
        revokeRuntimeApprovals(error);
        throw error;
      }
      assertLifecycleActive(`before broadcast ${decision.laneId}`);
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
        plan = revisePlan(plan, "INVALIDATED");
        store.saveExecutionPlan(plan);
        await vault.remove(vaultRef).catch(() => undefined);
        log(
          "INFO",
          "all routes deterministically rejected; lane returned for a fresh-block retry",
          {
            laneId: decision.laneId,
            intentId,
            releasedPlanId: planId,
            releasedReservationId: reservation.reservationId,
            observationId: decision.observationId,
          },
        );
        possiblySubmitted = false;
        slot = null;
        reservation = null;
        plan = null;
        attempt = null;
        vaultRef = null;
        throw new DroppedProvenLaneRetry(
          `DROPPED_PROVEN_RETRY: ${decision.laneId} requires a fresh observation and plan`,
        );
      }
      log("ACTION", "WETH lane broadcast completed", {
        laneId: decision.laneId,
        txHash,
        transportState: result.state,
        observedFeeBps: decision.observedFeeBps,
        principalWethRaw: decision.principalRaw.toString(),
      });
    } catch (error) {
      const updatedAt = new Date().toISOString();
      if (!possiblySubmitted) {
        let cleanupError: unknown = null;
        if (slot !== null) {
          try {
            coordinator.transition(slot, "RELEASED", updatedAt);
          } catch (candidate) {
            cleanupError = candidate;
          }
        }
        if (reservation !== null && slot !== null) {
          try {
            store.updateReservationState(reservation.reservationId, "RELEASED", updatedAt);
          } catch (candidate) {
            cleanupError ??= candidate;
          }
        }
        if (plan !== null && plan.state !== "INVALIDATED") {
          try {
            store.saveExecutionPlan(revisePlan(plan, "INVALIDATED"));
          } catch (candidate) {
            cleanupError ??= candidate;
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
          } catch (candidate) {
            cleanupError ??= candidate;
          }
        }
        if (vaultRef !== null) {
          try {
            await vault.remove(vaultRef);
          } catch (candidate) {
            cleanupError ??= candidate;
          }
        }
        if (cleanupError !== null) {
          throw new Error(
            `pre-broadcast cleanup could not be proven: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
        if (error instanceof PublicLaunchHandoffSuperseded) throw error;
        if (error instanceof LaneReadinessDeferred) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (classifyPreBroadcastFailure(error) === "FAILED_FINAL") {
          throw new ProvenPreBroadcastFailure(`DETERMINISTIC_PRE_BROADCAST_FAILURE: ${message}`);
        }
        throw new LaneReadinessDeferred(`PRE_BROADCAST_TRANSIENT_RETRY: ${message}`);
      }
      if (slot !== null) {
        try {
          coordinator.transition(slot, "UNKNOWN", updatedAt);
        } catch {
          // Possibly-submitted ownership remains fenced.
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
          // Signed bytes remain in the vault for reconciliation.
        }
      }
      throw error;
    }
  };

  const processHead = async (runtime: QuotedLaunchRuntime, blockNumber: bigint): Promise<void> => {
    if (stopping || blockNumber < BigInt(runtime.identity.blockNumber)) return;
    await assertCurrentPublicHandoffStillActive({ expected: handoff });
    assertLifecycleActive(`before processing head ${blockNumber.toString()}`);
    if (Date.now() >= runtime.expiresAtMs) {
      releaseEligibleLeases(true);
      endPaidLifecycle("LAUNCH_DEADLINE", "launch deadline reached; stopping paid executor");
      return;
    }
    if (!runtime.canaryApplied) {
      const canaryEffect = store
        .latestEffectRecords(STONK_SAFE_LAUNCH_STRATEGY_ID, runtime.identity.launchId)
        .find(
          (effect) =>
            effect.laneId === "clockin-entry-01" &&
            effect.canonicality === "CANONICAL" &&
            effect.result === "SUCCESS",
        );
      if (canaryEffect !== undefined) {
        const actual =
          canaryEffect.actualOutputRaw.state === "KNOWN"
            ? BigInt(canaryEffect.actualOutputRaw.value)
            : 0n;
        const minimum =
          (runtime.canaryExpectedOutputRaw *
            BigInt(10_000 - profile.entry.maximumExecutionDriftBps)) /
          10_000n;
        runtime.canaryEffectConfirmed = canaryEffect.result === "SUCCESS" && actual >= minimum;
        const canaryLane = runtime.orchestrator
          .snapshot()
          .find((lane) => lane.laneId === "clockin-entry-01");
        if (
          runtime.canaryEffectConfirmed &&
          (canaryLane?.state === "DISPATCHED" || canaryLane?.state === "UNKNOWN")
        ) {
          runtime.orchestrator.recordLaneOutcome(
            "clockin-entry-01",
            "EFFECT_CONFIRMED",
            `canonical canary effect ${canaryEffect.effectId}`,
          );
          releaseEligibleLeases(false);
        }
        runtime.orchestrator.applyCanaryCalibration(!runtime.canaryEffectConfirmed);
        runtime.canaryApplied = true;
      }
    }
    const observation = await runtime.pool.observe(blockNumber, [
      `head:${blockNumber.toString()}`,
      `profile:${profile.profileHash}`,
    ]);
    assertLifecycleActive(`after observing head ${blockNumber.toString()}`);
    if (!observation.inWindow) {
      releaseEligibleLeases(true);
      endPaidLifecycle("LAUNCH_DEADLINE", "canonical launch window ended; stopping paid executor");
      return;
    }
    if (
      !safeLaunchTaxIsBuyable(
        observation.currentFeeBps,
        runtime.launchState.startTaxBps,
        minimumReachableStonkSafeLaunchTaxBps(runtime.launchState),
      )
    ) {
      return;
    }
    const dependencies = await inspectExecutorDependencies(dependencyInput);
    runtime.reconcilerReady = dependencies.canaryReady;
    if (runtime.canaryEffectConfirmed) {
      readiness = await inspectStonkSafeLaunchWalletReadiness(canonical, walletBundle.manifest, {
        batchWethRaw: runtime.batchWethRaw,
        entryGasLimit: BigInt(profile.entry.gasLimit),
        maximumFeePerGasWei: BigInt(profile.entry.maximumFeePerGasWei),
        gasSafetyMarginBps: CLOCKIN_POLICY_V2.gasSafetyMarginBps,
      });
      readinessByWalletId = new Map(readiness.rows.map((row) => [row.walletId, row] as const));
      runtime.laterWalletsReady = quotedRemainingLanesReady({
        lanes: runtime.orchestrator.snapshot(),
        readinessRows: readiness.rows,
        unresolvedWalletAddresses: readiness.rows
          .filter((row) => store.walletHasUnresolvedNonce(row.address))
          .map((row) => row.address),
      });
    }
    const expansion = evaluateQuotedExpansion({
      canonicalCanaryEffect: runtime.canaryEffectConfirmed,
      strongCreatorPadBinding: true,
      allWalletsReady: runtime.laterWalletsReady,
      reconcilerReady: runtime.reconcilerReady,
    });
    const expansionSummary = expansion.ready ? "READY" : expansion.reasons.join(" | ");
    runtime.orchestrator.setLaterLaneExecutionReadiness(expansion.ready, expansionSummary);
    if (expansionSummary !== runtime.lastExpansionSummary) {
      runtime.lastExpansionSummary = expansionSummary;
      log(expansion.ready ? "INFO" : "ERROR", "quoted expansion gate changed", {
        ready: expansion.ready,
        reasons: expansion.reasons,
      });
    }
    const identityGate = evaluateRuntimeIdentityGate({
      officialCaState: runtime.officialCa.snapshot().state,
      gateMode: CLOCKIN_POLICY_V2.caGateMode,
      canaryEffectConfirmed: runtime.canaryEffectConfirmed,
      strongOnchainBindingReady: true,
    });
    if (identityGate.stopUnsent) runtime.orchestrator.applyCanaryCalibration(true);
    const quotes = new Map<string, QuoteSnapshot>();
    for (const lane of runtime.orchestrator.snapshot()) {
      if (lane.state === "DISPATCHED" || lane.state === "EFFECT_CONFIRMED") {
        continue;
      }
      try {
        const expected = await runtime.pool.previewBuyRaw(runtime.batchWethRaw, blockNumber);
        quotes.set(
          lane.laneId,
          createQuoteSnapshot({
            laneId: lane.laneId,
            poolObservationId: observation.observationId,
            profileRevision: profile.revision,
            blockNumber,
            blockHash: observation.block.blockHash,
            principalRaw: runtime.batchWethRaw,
            expectedTokenOutRaw: expected,
            observedAtMs: Date.now(),
            expiresAtMs: Date.now() + profile.entry.quoteMaximumAgeMs,
            evidenceIds: Object.freeze([observation.observationId]),
          }),
        );
      } catch (error) {
        log("ERROR", "quoted later-lane preview unavailable", {
          laneId: lane.laneId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const decisions = runtime.orchestrator.observe(observation, identityGate.identityLevel, quotes);
    await Promise.all(
      decisions.map(async (decision) => {
        const expected = resolveQuotedLaneExpectedOutputForDispatch({
          orchestrator: runtime.orchestrator,
          quotes,
          laneId: decision.laneId,
        });
        if (expected === null) {
          log("INFO", "quoted lane deferred before signing because its quote is unavailable", {
            laneId: decision.laneId,
            blockNumber: blockNumber.toString(),
          });
          return;
        }
        try {
          await dispatchLane(runtime, decision, observation.block.blockHash, blockNumber, expected);
        } catch (error) {
          if (error instanceof PublicLaunchHandoffSuperseded) {
            throw error;
          } else if (error instanceof LaneReadinessDeferred) {
            runtime.orchestrator.deferDispatchedLane(decision.laneId, error.message);
          } else {
            runtime.orchestrator.recordLaneOutcome(
              decision.laneId,
              error instanceof ProvenPreBroadcastFailure ? "REVERTED" : "UNKNOWN",
              error instanceof Error ? error.message : String(error),
            );
          }
          throw error;
        }
      }),
    );
  };

  let headQueue = Promise.resolve();
  let stopPromise: Promise<void> | null = null;
  const stop = (signal: string): Promise<void> => {
    if (stopPromise !== null) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      shutdown.abort();
      headsSubscription?.close();
      currentLaunch?.officialCa.stop();
      if (leaseTimer !== null) clearInterval(leaseTimer);
      if (statusTimer !== null) clearInterval(statusTimer);
      if (approvalTimer !== null) clearInterval(approvalTimer);
      if (authorizationTimer !== null) clearTimeout(authorizationTimer);
      if (armedWaitTimer !== null) clearTimeout(armedWaitTimer);
      if (launchDeadlineTimer !== null) clearTimeout(launchDeadlineTimer);
      await headQueue;
      releaseEligibleLeases(true);
      await writeStatus("STOPPING", [signal]);
      await watchdog.stopping(`quoted Safe Launch executor stopping after ${signal}`);
      store.close();
    })();
    return stopPromise;
  };
  const continuePaidLifecycle = async (stage: string): Promise<boolean> => {
    try {
      assertLifecycleActive(stage);
      return true;
    } catch (error) {
      if (!(error instanceof PaidExecutorLifecycleEnded)) throw error;
      await stop(error.reason);
      return false;
    }
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));

  let discovered: Awaited<ReturnType<typeof discoverStonkSafeLaunchClockIn>>;
  try {
    assertLifecycleActive("before LaunchCreated/LaunchArmed discovery");
    discovered = await runWhilePublicHandoffIsCurrent({
      expected: handoff,
      signal: shutdown.signal,
      operation: async (signal) =>
        await discoverStonkSafeLaunchClockIn({
          requester: canonical,
          wssUrl: rpcWss,
          profile: CLOCKIN_WETH_SAFE_LAUNCH_PROFILE,
          startBlock: BigInt(handoff.created.blockNumber),
          expectedCreated: handoff.created,
          signal,
          onEvent: async (event) => {
            log("INFO", `Safe Launch discovery ${event.kind.toLowerCase()}`);
            await writeStatus("WATCHING", [event.kind]);
          },
        }),
    });
    armed = true;
    recoveringExpiredArmedState = false;
    if (armedWaitTimer !== null) clearTimeout(armedWaitTimer);
    armedWaitTimer = null;
    assertLifecycleActive("after LaunchArmed discovery");
  } catch (error) {
    const ended = currentLifecycleEnd();
    if (ended !== null || stopping) {
      const reason = ended?.reason ?? "SIGNAL";
      await stop(reason);
      return;
    }
    throw error;
  }
  assertDiscoveryMatchesPublicHandoff(handoff, discovered.created);
  const canonicalHandoffCreated = await assertCanonicalSafeLaunchCreated({
    requester: canonical,
    created: discovered.created,
  });
  assertCanonicalCreatedMatchesPublicHandoff(handoff, canonicalHandoffCreated);
  if (!(await continuePaidLifecycle("after canonical public handoff reorg check"))) return;
  const adapter = new StonkSafeLaunchQuotedAdapter(canonical, CLOCKIN_WETH_SAFE_LAUNCH_PROFILE);
  const pool = new StonkSafeLaunchQuotedPoolRuntime({
    requester: canonical,
    created: discovered.created,
    armed: discovered.armed,
    profileRevision: profile.revision,
    profile: CLOCKIN_WETH_SAFE_LAUNCH_PROFILE,
  });
  const [launchState, armedOracleFresh] = await Promise.all([
    adapter.readLaunch(discovered.created.id, discovered.armed.blockNumber),
    adapter.oracleFresh(discovered.created.id, discovered.armed.blockNumber),
  ]);
  if (!armedOracleFresh) {
    throw new Error("LaunchArmed protocol oracle is stale at the exact Armed block");
  }
  launchDeadlineMs = Number(launchState.deadline) * 1_000;
  if (launchDeadlineTimer !== null) clearTimeout(launchDeadlineTimer);
  launchDeadlineTimer = scheduleLifecycleDeadline(
    launchDeadlineMs,
    "LAUNCH_DEADLINE",
    "launch deadline reached; aborting discovery and heads",
  );
  if (!(await continuePaidLifecycle("after exact Armed launch state read"))) return;
  assertArmedLaunchBinding({
    profile,
    launch: launchState,
    launchId: discovered.created.id,
    tokenAddress: discovered.created.tokenAddress,
    armedDeadline: discovered.armed.deadline,
  });
  const frozenAt = new Date().toISOString();
  const proposedIdentity = await buildCanonicalSafeLaunchIdentity({
    requester: canonical,
    profile,
    created: discovered.created,
    metadata: discovered.metadata,
    launch: launchState,
    frozenAt,
  });
  if (!(await continuePaidLifecycle("after canonical launch identity binding"))) return;
  const restoredIdentity = store
    .latestLaunchIdentities(STONK_SAFE_LAUNCH_STRATEGY_ID)
    .find(
      (identity) =>
        identity.transactionHash.toLowerCase() === proposedIdentity.transactionHash.toLowerCase() &&
        identity.logIndex === proposedIdentity.logIndex,
    );
  if (
    restoredIdentity !== undefined &&
    (restoredIdentity.tokenAddress.toLowerCase() !== proposedIdentity.tokenAddress.toLowerCase() ||
      restoredIdentity.poolAddress.toLowerCase() !== proposedIdentity.poolAddress.toLowerCase())
  ) {
    throw new Error("restored identity conflicts with exact WETH pad binding");
  }
  const identity = restoredIdentity ?? proposedIdentity;
  if (restoredIdentity === undefined) store.saveLaunchIdentity(identity);

  const armedBatchWethRaw = wethRawForUsdMicrosAtArmedQuote(
    CLOCKIN_POLICY_V2.nominalLaneUsdMicros,
    discovered.armed.quoteUsd8,
  );
  const armedRisk = assertArmedEntryRiskWithinCap({
    quoteUsd8: discovered.armed.quoteUsd8,
    laneCount: CLOCKIN_POLICY_V2.laneCount,
    nominalLaneUsdMicros: CLOCKIN_POLICY_V2.nominalLaneUsdMicros,
    gasLimit: BigInt(profile.entry.gasLimit),
    maximumFeePerGasWei: BigInt(profile.entry.maximumFeePerGasWei),
    allInRiskCapUsdMicros: CLOCKIN_POLICY_V2.allInRiskCapUsdMicros,
  });
  log("INFO", "LaunchArmed oracle froze exact WETH lane principal", {
    quoteUsd8: discovered.armed.quoteUsd8.toString(),
    batchWethRaw: armedBatchWethRaw.toString(),
    principalUsdMicros: armedRisk.principalUsdMicros.toString(),
    maximumGasUsdMicros: armedRisk.maximumGasUsdMicros.toString(),
    allInUsdMicros: armedRisk.totalUsdMicros.toString(),
  });
  await assertNoUnresolvedPreparationRecords(preparationJournal);
  if (!(await continuePaidLifecycle("after launch preparation recovery gate"))) return;

  const reservationIds = Array.from(
    { length: 10 },
    (_, index) => `${identity.launchId}:reservation-${String(index + 1).padStart(2, "0")}`,
  );
  const feePlan = planTenFeeBands(
    launchState.startTaxBps,
    minimumReachableStonkSafeLaunchTaxBps(launchState),
    walletBundle.manifest.entries.map((entry) => entry.walletId),
    reservationIds,
    CLOCKIN_POLICY_V2.nominalLaneUsdMicros,
    {
      strategyId: STONK_SAFE_LAUNCH_STRATEGY_ID,
      launchId: identity.launchId,
      mechanismProfileRevision: profile.revision,
      createdAt: frozenAt,
      windowDurationMs: launchState.windowSeconds * 1_000,
    },
  );
  store.saveFeeBandPlan(feePlan);
  const lanes: readonly WalletLane[] = Object.freeze(
    feePlan.lanes.map((lane, index) => {
      const entry = walletBundle.manifest.entries[index];
      if (entry === undefined) throw new Error("wallet manifest is shorter than fee plan");
      return Object.freeze({
        laneId: lane.laneId,
        strategyId: STONK_SAFE_LAUNCH_STRATEGY_ID,
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
      strategyId: STONK_SAFE_LAUNCH_STRATEGY_ID,
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
  const releasedPrePlanOrphans = recoverQuotedPrePlanOrphans({
    store,
    launchId: identity.launchId,
    ownerId,
    recoveredAt: new Date().toISOString(),
  });
  if (releasedPrePlanOrphans.length !== 0) {
    log("INFO", "released provably unsigned pre-plan entry reservations after restart", {
      count: releasedPrePlanOrphans.length,
      reservationIds: releasedPrePlanOrphans.map((record) => record.reservationId),
    });
  }
  const releasedPreBroadcastOrphans = recoverQuotedProvenPreBroadcastOrphans({
    store,
    launchId: identity.launchId,
    ownerId,
    recoveredAt: new Date().toISOString(),
  });
  for (const released of releasedPreBroadcastOrphans) {
    if (released.vaultRef !== undefined)
      await vault.remove(released.vaultRef).catch(() => undefined);
  }
  if (releasedPreBroadcastOrphans.length !== 0) {
    log("INFO", "released plans proven to have crashed before the durable broadcast boundary", {
      count: releasedPreBroadcastOrphans.length,
      planIds: releasedPreBroadcastOrphans.map((record) => record.planId),
    });
  }
  const restoredPlans = store.latestExecutionPlans(
    STONK_SAFE_LAUNCH_STRATEGY_ID,
    identity.launchId,
  );
  const restoredAttempts = store.latestTxAttempts(STONK_SAFE_LAUNCH_STRATEGY_ID, identity.launchId);
  const restoredEffects = store.latestEffectRecords(
    STONK_SAFE_LAUNCH_STRATEGY_ID,
    identity.launchId,
  );
  const freshLaunchState =
    restoredPlans.length === 0 && restoredAttempts.length === 0 && restoredEffects.length === 0;
  const laneRecoveries: QuotedLaneRecovery[] = [];
  for (const lane of feePlan.lanes) {
    const entry = walletBundle.manifest.entries.find(
      (candidate) => candidate.walletId === lane.walletId,
    );
    if (entry === undefined) throw new Error(`lane ${lane.laneId} has no wallet manifest entry`);
    const recovery = selectQuotedLaneRecovery({
      laneId: lane.laneId,
      walletAddress: entry.address,
      plans: restoredPlans,
      attempts: restoredAttempts,
      effects: restoredEffects,
    });
    laneRecoveries.push(recovery);
  }
  const restoredSnapshotByLane = new Map<string, EntryBroadcastSnapshot>();
  for (const recovery of laneRecoveries) {
    if (recovery.state === "WAITING") continue;
    const attempt = recovery.sourceAttempt;
    if (attempt === undefined) {
      throw new Error(`restored lane ${recovery.laneId} has no source attempt`);
    }
    const snapshotEvent = store
      .auditEvents(STONK_SAFE_LAUNCH_STRATEGY_ID, identity.launchId)
      .find(
        (event) =>
          event.objectId === attempt.attemptId &&
          event.eventKind === "ENTRY_PRE_BROADCAST_SNAPSHOT",
      );
    if (snapshotEvent === undefined) {
      throw new Error(`restored lane ${recovery.laneId} has no durable pre-broadcast snapshot`);
    }
    const snapshot = parseProductionBroadcastSnapshot(snapshotEvent.payload);
    if (
      snapshot.kind !== "ENTRY_BUY" ||
      snapshot.principalAssetKind !== "ERC20" ||
      snapshot.principalAsset.toLowerCase() !== profile.quote.asset.toLowerCase() ||
      BigInt(snapshot.plannedPrincipalRaw) <= 0n
    ) {
      throw new Error(`restored lane ${recovery.laneId} snapshot is not a WETH entry buy`);
    }
    restoredSnapshotByLane.set(recovery.laneId, snapshot);
  }
  const recoveredPrincipalRaw = laneRecoveries.reduce(
    (total, recovery) =>
      total +
      (recovery.state === "WAITING"
        ? 0n
        : BigInt(restoredSnapshotByLane.get(recovery.laneId)?.plannedPrincipalRaw ?? "0")),
    0n,
  );
  const remainingLaneCount = laneRecoveries.filter(
    (recovery) => recovery.state === "WAITING",
  ).length;
  const freshAggregatePrincipalRaw = armedBatchWethRaw * 10n;
  const recoveredAggregatePrincipalRaw =
    recoveredPrincipalRaw + armedBatchWethRaw * BigInt(remainingLaneCount);
  const orchestrator = new TenLaneOrchestrator(feePlan, {
    batchPrincipalRaw: armedBatchWethRaw,
    minimumShrunkPrincipalRaw: armedBatchWethRaw,
    aggregatePrincipalCapRaw:
      recoveredAggregatePrincipalRaw > freshAggregatePrincipalRaw
        ? recoveredAggregatePrincipalRaw
        : freshAggregatePrincipalRaw,
    catchUpPolicy: CLOCKIN_POLICY_V2.catchUpPolicy,
    maxConcurrentCatchUpLanes: CLOCKIN_POLICY_V2.maxConcurrentCatchUpLanes,
    capPolicy: "STRICT_5U",
  });
  for (const recovery of laneRecoveries) {
    if (recovery.state !== "WAITING") {
      orchestrator.restoreLane({
        laneId: recovery.laneId,
        state: recovery.state,
        dispatchedPrincipalRaw: BigInt(
          restoredSnapshotByLane.get(recovery.laneId)?.plannedPrincipalRaw ?? "0",
        ),
        reason: `restored ${recovery.state} from ${recovery.sourcePlan?.planId ?? "canonical history"}`,
      });
    }
    // INVALIDATED/DROPPED_PROVEN-only history is deliberately left WAITING for a fresh block.
  }

  readiness = await inspectStonkSafeLaunchWalletReadiness(canonical, walletBundle.manifest, {
    batchWethRaw: armedBatchWethRaw,
    entryGasLimit: BigInt(profile.entry.gasLimit),
    maximumFeePerGasWei: BigInt(profile.entry.maximumFeePerGasWei),
    gasSafetyMarginBps: CLOCKIN_POLICY_V2.gasSafetyMarginBps,
  });
  if (!(await continuePaidLifecycle("after restored-lane wallet readiness"))) return;
  readinessByWalletId = new Map(readiness.rows.map((row) => [row.walletId, row] as const));
  startupDependencies = await inspectExecutorDependencies(dependencyInput);
  if (freshLaunchState && !readiness.allLanesArmed) {
    throw new Error(
      "LaunchArmed 5U WETH requirement exceeds a prepared wallet balance/allowance or gas readiness changed; rerun the 10% buffer preparation before re-arming",
    );
  }
  if (freshLaunchState && !startupDependencies.canaryReady) {
    throw new Error(
      `canonical reconciler is not ready: ${startupDependencies.canaryReasons.join("; ")}`,
    );
  }
  for (const recovery of laneRecoveries) {
    const lane = feePlan.lanes.find((candidate) => candidate.laneId === recovery.laneId);
    const row = readiness.rows.find((candidate) => candidate.walletId === lane?.walletId);
    if (row === undefined) throw new Error(`lane ${recovery.laneId} has no readiness row`);
    const hasUnresolvedPersistentNonce = store.walletHasUnresolvedNonce(row.address);
    assertQuotedLaneRecoveryReadiness({
      recovery,
      readiness: row,
      hasUnresolvedPersistentNonce,
    });
    if (recovery.state !== "WAITING") continue;
    const now = new Date().toISOString();
    const epoch = coordinator.acquire(
      row.address,
      ownerId,
      row.latestNonce,
      row.pendingNonce,
      now,
      expiry(Date.parse(now), LEASE_TTL_MS),
    );
    const binding = { walletAddress: row.address, epoch, active: true };
    leases.push(binding);
    leaseByAddress.set(row.address.toLowerCase(), binding);
  }
  const remainingLanesReady = quotedRemainingLanesReady({
    lanes: orchestrator.snapshot(),
    readinessRows: readiness.rows,
    unresolvedWalletAddresses: readiness.rows
      .filter((row) => store.walletHasUnresolvedNonce(row.address))
      .map((row) => row.address),
  });
  const restoredCanarySnapshot = restoredSnapshotByLane.get("clockin-entry-01");
  let canaryExpectedOutputRaw = 0n;
  if (restoredCanarySnapshot !== undefined) {
    canaryExpectedOutputRaw = BigInt(restoredCanarySnapshot.expectedTokenOutRaw);
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
  if (!(await continuePaidLifecycle("before asynchronous official CA fallback"))) return;
  void officialCa.start().catch((error: unknown) =>
    log("ERROR", "official CA fallback monitor failed", {
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  currentLaunch = {
    identity,
    created: discovered.created,
    adapter,
    pool,
    launchState,
    feePlan,
    orchestrator,
    batchWethRaw: armedBatchWethRaw,
    canaryExpectedOutputRaw,
    officialCa,
    expiresAtMs: launchDeadlineMs,
    canaryApplied: false,
    canaryEffectConfirmed: false,
    laterWalletsReady: remainingLanesReady,
    reconcilerReady: startupDependencies.canaryReady,
    lastExpansionSummary: "",
  };
  await writeStatus("ACTIVE", [
    "CLOCKIN_STRONG_CREATOR_PAD_IDENTITY_FROZEN",
    `CREATED_SOURCE_${discovered.createdSource}`,
    `ARMED_SOURCE_${discovered.armedSource}`,
  ]);
  if (!(await continuePaidLifecycle("before first Armed head processing"))) return;
  await processHead(currentLaunch, discovered.armed.blockNumber);
  if (!(await continuePaidLifecycle("after first Armed head processing"))) return;

  if (!(await continuePaidLifecycle("before newHeads subscription construction"))) return;
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
        log("ERROR", "quoted Safe Launch head processing failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof PublicLaunchHandoffSuperseded) {
          process.exitCode = 1;
          shutdown.abort();
          headsSubscription?.close();
        }
      });
  });
  if (!(await continuePaidLifecycle("after newHeads subscription establishment"))) return;
  await headsSubscription.done;
  const ended = currentLifecycleEnd();
  if (ended !== null) {
    const unresolvedAttemptCount = store.unresolvedTxAttempts(STONK_SAFE_LAUNCH_STRATEGY_ID).length;
    log("INFO", "paid executor lifecycle ended", {
      reason: ended.reason,
      unresolvedAttemptCount,
      reconciliationOwner: unresolvedAttemptCount === 0 ? "NONE_REQUIRED" : "CLOCKIN_RECONCILER",
    });
    await stop(ended.reason);
    return;
  }
  if (stopping) {
    await stop("SIGNAL");
    return;
  }
  await stop("UNEXPECTED_NEW_HEADS_END");
  throw new Error("newHeads subscription ended unexpectedly");
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

if (isDirectExecution()) {
  void runStonkSafeLaunchExecutorService().catch((error: unknown) => {
    if (error instanceof PaidExecutorLifecycleEnded) {
      process.stdout.write(
        `${JSON.stringify({
          service: "clockin-safe-launch-executor",
          state: "STOPPED",
          reason: error.reason,
          message: error.message,
        })}\n`,
      );
      return;
    }
    process.stderr.write(
      `${JSON.stringify({
        service: "clockin-safe-launch-executor",
        state: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  });
}
