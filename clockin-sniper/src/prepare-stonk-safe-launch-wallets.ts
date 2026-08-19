import {
  access,
  appendFile,
  chmod,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getBytes, Interface, isHexString, keccak256, type Wallet } from "ethers";

import {
  CLOCKIN_WETH_SAFE_LAUNCH_PROFILE,
  ROBINHOOD_WETH_ADDRESS,
  STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
  verifyStonkSafeLaunchQuotedProfile,
} from "./adapters/stonk-safe-launch-quoted.js";
import {
  SameRawBroadcaster,
  type SameRawBroadcastResult,
} from "./broadcast/same-raw-broadcaster.js";
import { CLOCKIN_POLICY_V2 } from "./config/strategy-config.js";
import type { Address, Hex32 } from "./core/canonical.js";
import { HttpJsonRpcClient } from "./rpc/http-json-rpc.js";
import { hexToBigInt, quantityToHex } from "./rpc/hex.js";
import type { Hex, JsonRpcRequester } from "./rpc/types.js";
import {
  loadProductionWalletSigners,
  loadStonkSafeLaunchProfileAndAuthorization,
  loadVaultKey,
  readSystemdCredential,
} from "./runtime/credentials.js";
import { assertPaidRpcApproved } from "./runtime/paid-rpc-approval.js";
import { assertProductionArmApproved } from "./runtime/production-arm-approval.js";
import { ProductionPriceCache } from "./runtime/production-price.js";
import {
  ProductionSameRawProvider,
  readGenesisHash,
  readProductionReceipt,
  type ProductionReceipt,
} from "./runtime/production-rpc.js";
import {
  planStonkSafeLaunchWalletPreparation,
  type StonkSafeLaunchPreparationAction,
  type StonkSafeLaunchPreparationGasPolicy,
  type StonkSafeLaunchWalletPreparationPlan,
} from "./runtime/stonk-safe-launch-wallet-preparation.js";
import {
  inspectStonkSafeLaunchWalletReadiness,
  type StonkSafeLaunchWalletReadinessReport,
  type StonkSafeLaunchWalletReadinessRow,
} from "./runtime/stonk-safe-launch-wallet-readiness.js";
import { SignedTxVault } from "./wallets/signed-tx-vault.js";

const PRINCIPAL_BUFFER_BPS = 1_000;
const MAXIMUM_PRINCIPAL_BUFFER_BPS = 1_000;
const DEPOSIT_GAS_LIMIT = 80_000n;
const APPROVAL_GAS_LIMIT = 100_000n;
const ENTRY_GAS_LIMIT = 500_000n;
const GAS_SAFETY_MARGIN_BPS = 3_000;
const RECEIPT_POLL_MS = 250;
const RECEIPT_TIMEOUT_MS = 240_000;
const DEFAULT_STATE_DIRECTORY = "/var/lib/clockin-sniper";

const wethInterface = new Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
]);

export interface StonkSafeLaunchPreparationBatchPlan {
  readonly nominalBatchWethRaw: bigint;
  readonly bufferedBatchWethRaw: bigint;
  readonly principalBufferBps: number;
  readonly wallets: readonly StonkSafeLaunchWalletPreparationPlan[];
  readonly executable: boolean;
}

export interface StonkSafeLaunchPreparationRiskReport {
  readonly bufferedPrincipalUsdMicros: bigint;
  readonly completedPreparationGasWei: bigint;
  readonly completedPreparationGasUsdMicros: bigint;
  readonly remainingMaximumGasUsdMicros: bigint;
  readonly maximumGasUsdMicros: bigint;
  readonly totalUsdMicros: bigint;
  readonly capUsdMicros: bigint;
}

export interface CanonicalPreparationReceipt {
  readonly txHash: Hex32;
  readonly walletAddress: Address;
  readonly nonce: bigint;
  readonly action: StonkSafeLaunchPreparationAction["kind"];
  readonly blockNumber: bigint;
  readonly blockHash: Hex32;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly status: 0 | 1;
}

export class PreparationFeeDeferred extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparationFeeDeferred";
  }
}

export interface CanonicalPreparationFeeSnapshot {
  readonly blockNumber: bigint;
  readonly blockHash: Hex32;
  readonly baseFeePerGasWei: bigint;
}

export type PreparationRecoveryState =
  | "PREPARED"
  | "STORED"
  | "BROADCASTING"
  | "ACCEPTED"
  | "KNOWN"
  | "UNKNOWN"
  | "REJECTED"
  | "FINAL"
  | "FINAL_REVERTED"
  | "CLEARED";

export interface PreparationRecoveryRecord {
  readonly version: 1;
  /** Monotonic, per-signed-hash attempt. Legacy records without this field parse as attempt 1. */
  readonly attempt: number;
  readonly txHash: Hex32;
  readonly walletAddress: Address;
  readonly nonce: string;
  readonly action: StonkSafeLaunchPreparationAction["kind"];
  readonly vaultRef: string;
  readonly state: PreparationRecoveryState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly receipt?: Readonly<{
    readonly blockNumber: string;
    readonly blockHash: Hex32;
    readonly status: 0 | 1;
  }>;
}

const terminalRecoveryStates = new Set<PreparationRecoveryState>([
  "FINAL",
  "FINAL_REVERTED",
  "CLEARED",
]);

function recoveryRecordJson(record: PreparationRecoveryRecord): string {
  return `${JSON.stringify(record)}\n`;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeNewDurable(path: string, body: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  await chmod(path, 0o600);
  await syncDirectory(directory);
}

async function replaceDurable(path: string, body: string): Promise<void> {
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await chmod(path, 0o600);
  await syncDirectory(directory);
}

function parseRecoveryRecord(raw: string): PreparationRecoveryRecord {
  const value = JSON.parse(raw) as Partial<PreparationRecoveryRecord>;
  const receipt = value.receipt as
    | Partial<NonNullable<PreparationRecoveryRecord["receipt"]>>
    | undefined;
  if (
    value.version !== 1 ||
    (value.attempt !== undefined && (!Number.isSafeInteger(value.attempt) || value.attempt < 1)) ||
    typeof value.txHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/u.test(value.txHash) ||
    typeof value.walletAddress !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/u.test(value.walletAddress) ||
    typeof value.nonce !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value.nonce) ||
    (value.action !== "WRAP_WETH" && value.action !== "APPROVE_WETH") ||
    typeof value.vaultRef !== "string" ||
    typeof value.state !== "string" ||
    ![
      "PREPARED",
      "STORED",
      "BROADCASTING",
      "ACCEPTED",
      "KNOWN",
      "UNKNOWN",
      "REJECTED",
      "FINAL",
      "FINAL_REVERTED",
      "CLEARED",
    ].includes(value.state) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (receipt !== undefined &&
      (typeof receipt.blockNumber !== "string" ||
        !/^(?:0|[1-9][0-9]*)$/u.test(receipt.blockNumber) ||
        typeof receipt.blockHash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/u.test(receipt.blockHash) ||
        (receipt.status !== 0 && receipt.status !== 1))) ||
    ((value.state === "FINAL" || value.state === "FINAL_REVERTED") && receipt === undefined) ||
    (value.state === "FINAL" && receipt?.status !== 1) ||
    (value.state === "FINAL_REVERTED" && receipt?.status !== 0)
  ) {
    throw new Error("invalid wallet preparation recovery record");
  }
  return Object.freeze({ ...value, attempt: value.attempt ?? 1 }) as PreparationRecoveryRecord;
}

/**
 * A durable, redacted write-ahead index for the encrypted signed transaction vault.
 * The PREPARED record is fsynced before vault.put(), closing the vault-put -> record gap.
 */
export class PreparationRecoveryJournal {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = resolve(directory);
  }

  #path(txHash: Hex32, attempt: number): string {
    const suffix = attempt === 1 ? "" : `.${attempt}`;
    return join(this.#directory, `${txHash.slice(2).toLowerCase()}${suffix}.json`);
  }

  async create(
    input: Omit<
      PreparationRecoveryRecord,
      "version" | "attempt" | "state" | "createdAt" | "updatedAt"
    > & {
      readonly createdAt: string;
    },
  ): Promise<PreparationRecoveryRecord> {
    const prior = (await this.list()).filter(
      (record) => record.txHash.toLowerCase() === input.txHash.toLowerCase(),
    );
    if (prior.some((record) => record.state !== "CLEARED")) {
      throw new Error("wallet preparation signed hash already has a non-cleared recovery attempt");
    }
    const attempt = prior.reduce((maximum, record) => Math.max(maximum, record.attempt), 0) + 1;
    const record = Object.freeze({
      ...input,
      version: 1 as const,
      attempt,
      state: "PREPARED" as const,
      updatedAt: input.createdAt,
    });
    await writeNewDurable(this.#path(record.txHash, record.attempt), recoveryRecordJson(record));
    return record;
  }

  async transition(
    record: PreparationRecoveryRecord,
    state: PreparationRecoveryState,
    updatedAt: string,
    receipt?: PreparationRecoveryRecord["receipt"],
  ): Promise<PreparationRecoveryRecord> {
    if (terminalRecoveryStates.has(record.state) && record.state !== state) {
      throw new Error("terminal wallet preparation recovery record cannot transition");
    }
    const next = Object.freeze({ ...record, state, updatedAt, ...(receipt ? { receipt } : {}) });
    await replaceDurable(this.#path(record.txHash, record.attempt), recoveryRecordJson(next));
    return next;
  }

  async list(): Promise<readonly PreparationRecoveryRecord[]> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const names = (await readdir(this.#directory))
      .filter((name) => /^[0-9a-f]{64}(?:\.[1-9][0-9]*)?\.json$/u.test(name))
      .sort();
    const records = await Promise.all(
      names.map(async (name) =>
        parseRecoveryRecord(await readFile(join(this.#directory, name), "utf8")),
      ),
    );
    return Object.freeze(
      records.sort(
        (left, right) => left.txHash.localeCompare(right.txHash) || left.attempt - right.attempt,
      ),
    );
  }

  async unresolved(): Promise<readonly PreparationRecoveryRecord[]> {
    return (await this.list()).filter((record) => !terminalRecoveryStates.has(record.state));
  }
}

export function signedTxVaultReference(vaultDirectory: string, txHash: Hex32): string {
  return join(resolve(vaultDirectory), `${txHash.slice(2).toLowerCase()}.vault`);
}

export async function assertNoUnresolvedPreparationRecords(
  journal: PreparationRecoveryJournal,
): Promise<void> {
  const unresolved = await journal.unresolved();
  if (unresolved.length !== 0) {
    throw new Error(
      `wallet preparation recovery is unresolved (${unresolved.length}); executor readiness is blocked`,
    );
  }
}

export function bufferedWethPrincipal(nominalRaw: bigint, bufferBps: number): bigint {
  if (nominalRaw <= 0n) throw new RangeError("nominal WETH principal must be positive");
  if (
    !Number.isSafeInteger(bufferBps) ||
    bufferBps < 0 ||
    bufferBps > MAXIMUM_PRINCIPAL_BUFFER_BPS
  ) {
    throw new RangeError("principal buffer must be in 0..1000 bps");
  }
  return nominalRaw + (nominalRaw * BigInt(bufferBps) + 9_999n) / 10_000n;
}

function exactAllowanceAction(
  amountRaw: bigint,
  gasLimit: bigint,
): StonkSafeLaunchPreparationAction {
  return Object.freeze({
    kind: "APPROVE_WETH",
    target: ROBINHOOD_WETH_ADDRESS,
    valueRaw: 0n,
    calldata: wethInterface.encodeFunctionData("approve", [
      STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
      amountRaw,
    ]) as Hex,
    gasLimit,
  });
}

/**
 * Convert the shared minimum-allowance planner into the production preparation
 * invariant: the pad allowance must equal (not merely exceed) the buffered 5U amount.
 */
export function enforceExactBufferedAllowance(
  plan: StonkSafeLaunchWalletPreparationPlan,
  approvalGasLimit: bigint,
  maximumFeePerGasWei: bigint,
  gasSafetyMarginBps: number,
): StonkSafeLaunchWalletPreparationPlan {
  if (plan.currentAllowanceRaw === plan.batchWethRaw) return plan;
  const actions = [
    ...plan.actions.filter((action) => action.kind !== "APPROVE_WETH"),
    exactAllowanceAction(plan.batchWethRaw, approvalGasLimit),
  ];
  const preparationGasBaseWei = actions.reduce(
    (total, action) => total + action.gasLimit * maximumFeePerGasWei,
    0n,
  );
  const preparationGasReserveWei =
    preparationGasBaseWei + (preparationGasBaseWei * BigInt(gasSafetyMarginBps) + 9_999n) / 10_000n;
  const totalNativeRequiredWei =
    plan.wethDeficitRaw + plan.entryGasReserveWei + preparationGasReserveWei;
  const nativeShortfallWei =
    plan.nativeBalanceWei >= totalNativeRequiredWei
      ? 0n
      : totalNativeRequiredWei - plan.nativeBalanceWei;
  return Object.freeze({
    ...plan,
    actions: Object.freeze(actions),
    preparationGasReserveWei,
    totalNativeRequiredWei,
    nativeShortfallWei,
    readyWithoutTransactions: false,
    executable: nativeShortfallWei === 0n,
  });
}

export function planStonkSafeLaunchPreparationBatch(input: {
  readonly readiness: StonkSafeLaunchWalletReadinessReport;
  readonly nominalBatchWethRaw: bigint;
  readonly principalBufferBps: number;
  readonly gas: StonkSafeLaunchPreparationGasPolicy;
}): StonkSafeLaunchPreparationBatchPlan {
  if (input.readiness.rows.length !== 10) throw new RangeError("ten wallet rows are required");
  const bufferedBatchWethRaw = bufferedWethPrincipal(
    input.nominalBatchWethRaw,
    input.principalBufferBps,
  );
  const wallets = input.readiness.rows.map((row) =>
    enforceExactBufferedAllowance(
      planStonkSafeLaunchWalletPreparation({
        walletAddress: row.address,
        nativeBalanceWei: row.nativeBalanceWei,
        wethBalanceRaw: row.wethBalanceRaw,
        wethAllowanceRaw: row.wethAllowanceRaw,
        batchWethRaw: bufferedBatchWethRaw,
        gas: input.gas,
      }),
      input.gas.approvalGasLimit,
      input.gas.maximumFeePerGasWei,
      input.gas.gasSafetyMarginBps,
    ),
  );
  return Object.freeze({
    nominalBatchWethRaw: input.nominalBatchWethRaw,
    bufferedBatchWethRaw,
    principalBufferBps: input.principalBufferBps,
    wallets: Object.freeze(wallets),
    executable: wallets.length === 10 && wallets.every((plan) => plan.executable),
  });
}

function weiToUsdMicrosCeil(wei: bigint, usdMicrosPerEth: bigint): bigint {
  if (wei < 0n || usdMicrosPerEth <= 0n) throw new RangeError("preparation risk price is invalid");
  const denominator = 1_000_000_000_000_000_000n;
  return (wei * usdMicrosPerEth + denominator - 1n) / denominator;
}

export function completedPreparationGasWei(
  receipts: readonly CanonicalPreparationReceipt[],
): bigint {
  const transactionHashes = new Set<string>();
  let total = 0n;
  for (const receipt of receipts) {
    const normalizedHash = receipt.txHash.toLowerCase();
    if (transactionHashes.has(normalizedHash)) {
      throw new Error("preparation receipt ledger contains a duplicate transaction hash");
    }
    transactionHashes.add(normalizedHash);
    if (receipt.gasUsed < 0n || receipt.effectiveGasPrice < 0n) {
      throw new RangeError("preparation receipt gas values cannot be negative");
    }
    total += receipt.gasUsed * receipt.effectiveGasPrice;
  }
  return total;
}

/** Freeze the whole ten-wallet risk envelope before the first real preparation transaction. */
export function assertPreparationAllInRiskWithinCap(input: {
  readonly batch: StonkSafeLaunchPreparationBatchPlan;
  readonly usdMicrosPerEth: bigint;
  readonly allInRiskCapUsdMicros: bigint;
  readonly completedReceipts?: readonly CanonicalPreparationReceipt[];
}): StonkSafeLaunchPreparationRiskReport {
  if (input.batch.wallets.length !== 10) throw new RangeError("ten wallet plans are required");
  const bufferedPrincipalWei = input.batch.bufferedBatchWethRaw * 10n;
  const completedGasWei = completedPreparationGasWei(input.completedReceipts ?? []);
  const remainingMaximumGasWei = input.batch.wallets.reduce(
    (total, wallet) => total + wallet.entryGasReserveWei + wallet.preparationGasReserveWei,
    0n,
  );
  const maximumGasWei = completedGasWei + remainingMaximumGasWei;
  const bufferedPrincipalUsdMicros = weiToUsdMicrosCeil(
    bufferedPrincipalWei,
    input.usdMicrosPerEth,
  );
  const completedPreparationGasUsdMicros = weiToUsdMicrosCeil(
    completedGasWei,
    input.usdMicrosPerEth,
  );
  const remainingMaximumGasUsdMicros = weiToUsdMicrosCeil(
    remainingMaximumGasWei,
    input.usdMicrosPerEth,
  );
  const maximumGasUsdMicros = weiToUsdMicrosCeil(maximumGasWei, input.usdMicrosPerEth);
  const totalUsdMicros = bufferedPrincipalUsdMicros + maximumGasUsdMicros;
  if (totalUsdMicros > input.allInRiskCapUsdMicros) {
    throw new Error(
      `frozen preparation principal plus maximum wrap/approve/entry gas ${totalUsdMicros} USD micros exceeds the ${input.allInRiskCapUsdMicros} all-in cap`,
    );
  }
  return Object.freeze({
    bufferedPrincipalUsdMicros,
    completedPreparationGasWei: completedGasWei,
    completedPreparationGasUsdMicros,
    remainingMaximumGasUsdMicros,
    maximumGasUsdMicros,
    totalUsdMicros,
    capUsdMicros: input.allInRiskCapUsdMicros,
  });
}

export function assertPreparationCanBroadcast(input: {
  readonly batch: StonkSafeLaunchPreparationBatchPlan;
  readonly authorizationExpiresAt: string;
  readonly nowMs: number;
}): void {
  if (!input.batch.executable || input.batch.wallets.length !== 10) {
    throw new Error("all ten wallet plans must be executable before the first broadcast");
  }
  if (!Number.isFinite(Date.parse(input.authorizationExpiresAt))) {
    throw new TypeError("authorization expiry must be ISO-8601");
  }
  if (input.nowMs >= Date.parse(input.authorizationExpiresAt)) {
    throw new Error("production authorization expired before wallet preparation");
  }
}

export function assertProceedableBroadcast(result: SameRawBroadcastResult): void {
  if (result.state === "UNKNOWN") {
    throw new Error("wallet preparation broadcast is UNKNOWN; exact-raw recovery is required");
  }
  if (result.state === "REJECTED") {
    throw new Error("wallet preparation broadcast was deterministically rejected");
  }
}

export function assertCanonicalPreparationReceipt(input: {
  readonly receipt: ProductionReceipt;
  readonly expectedTxHash: Hex32;
  readonly expectedBlockHash: Hex32;
  readonly observedLatestNonce: bigint;
  readonly submittedNonce: bigint;
}): void {
  if (
    input.receipt.transactionHash.toLowerCase() !== input.expectedTxHash.toLowerCase() ||
    input.receipt.blockHash.toLowerCase() !== input.expectedBlockHash.toLowerCase()
  ) {
    throw new Error("wallet preparation receipt is not canonically bound");
  }
  if (input.observedLatestNonce <= input.submittedNonce) {
    throw new Error("wallet nonce did not advance after the canonical receipt");
  }
}

function readinessRowByAddress(
  report: StonkSafeLaunchWalletReadinessReport,
  address: Address,
): StonkSafeLaunchWalletReadinessRow {
  const row = report.rows.find(
    (candidate) => candidate.address.toLowerCase() === address.toLowerCase(),
  );
  if (row === undefined) throw new Error("wallet readiness row is missing");
  return row;
}

function redactedJson(value: object): string {
  return `${JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  )}\n`;
}

async function appendEvidence(path: string, value: object): Promise<void> {
  await appendFile(path, redactedJson(value), { encoding: "utf8", mode: 0o600 });
}

async function readAndAssertCanonicalPreparationReceipt(
  requester: JsonRpcRequester,
  expected: CanonicalPreparationReceipt,
): Promise<CanonicalPreparationReceipt> {
  const receipt = await readProductionReceipt(requester, expected.txHash);
  if (receipt === null) {
    throw new Error("a prior wallet preparation receipt is no longer available");
  }
  const [block, latestNonceRaw] = await Promise.all([
    requester.request<{ readonly hash?: unknown } | null>("eth_getBlockByNumber", [
      quantityToHex(expected.blockNumber),
      false,
    ]),
    requester.request<string>("eth_getTransactionCount", [expected.walletAddress, "latest"]),
  ]);
  if (block === null || typeof block.hash !== "string" || !isHexString(block.hash, 32)) {
    throw new Error("a prior wallet preparation receipt block is unavailable");
  }
  assertCanonicalPreparationReceipt({
    receipt,
    expectedTxHash: expected.txHash,
    expectedBlockHash: block.hash as Hex32,
    observedLatestNonce: hexToBigInt("latest nonce", latestNonceRaw),
    submittedNonce: expected.nonce,
  });
  if (
    receipt.blockNumber !== expected.blockNumber ||
    receipt.blockHash.toLowerCase() !== expected.blockHash.toLowerCase() ||
    receipt.status !== expected.status ||
    receipt.gasUsed !== expected.gasUsed ||
    receipt.effectiveGasPrice !== expected.effectiveGasPrice
  ) {
    throw new Error("a prior wallet preparation receipt changed after it was recorded");
  }
  return expected;
}

export async function assertPriorPreparationReceiptsCanonical(
  requester: JsonRpcRequester,
  receipts: readonly CanonicalPreparationReceipt[],
): Promise<void> {
  for (const receipt of receipts) {
    await readAndAssertCanonicalPreparationReceipt(requester, receipt);
  }
}

async function waitForCanonicalReceipt(input: {
  readonly requester: JsonRpcRequester;
  readonly txHash: Hex32;
  readonly walletAddress: Address;
  readonly nonce: bigint;
  readonly action: StonkSafeLaunchPreparationAction["kind"];
  readonly timeoutMs: number;
  readonly pollMs: number;
}): Promise<CanonicalPreparationReceipt> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await readProductionReceipt(input.requester, input.txHash);
    if (receipt !== null) {
      const [block, latestNonceRaw] = await Promise.all([
        input.requester.request<{ readonly hash?: unknown } | null>("eth_getBlockByNumber", [
          quantityToHex(receipt.blockNumber),
          false,
        ]),
        input.requester.request<string>("eth_getTransactionCount", [input.walletAddress, "latest"]),
      ]);
      if (block === null || typeof block.hash !== "string") {
        throw new Error("canonical receipt block is unavailable");
      }
      assertCanonicalPreparationReceipt({
        receipt,
        expectedTxHash: input.txHash,
        expectedBlockHash: block.hash as Hex32,
        observedLatestNonce: hexToBigInt("latest nonce", latestNonceRaw),
        submittedNonce: input.nonce,
      });
      return Object.freeze({
        txHash: input.txHash,
        walletAddress: input.walletAddress,
        nonce: input.nonce,
        action: input.action,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        status: receipt.status,
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, input.pollMs));
  }
  throw new Error("wallet preparation receipt remained UNKNOWN until timeout");
}

export interface PreparationRecoveryProbeSnapshot {
  readonly receipt: ProductionReceipt | null;
  readonly transactionKnown: boolean;
  readonly latestNonce: bigint;
  readonly pendingNonce: bigint;
}

export interface PreparationRecoveryVault {
  exists(reference: string): Promise<boolean>;
  get(reference: string, expectedTxHash: Hex32): Promise<Hex>;
  remove(reference: string): Promise<void>;
}

export interface PreparationRecoveryRuntime {
  readonly journal: PreparationRecoveryJournal;
  readonly vault: PreparationRecoveryVault;
  readonly probe: (record: PreparationRecoveryRecord) => Promise<PreparationRecoveryProbeSnapshot>;
  readonly waitForReceipt: (
    record: PreparationRecoveryRecord,
  ) => Promise<CanonicalPreparationReceipt>;
  readonly broadcaster: Pick<SameRawBroadcaster, "broadcast">;
  readonly assertMarkers: () => Promise<void>;
  readonly now: () => string;
}

function nonceIsUnconsumed(snapshot: PreparationRecoveryProbeSnapshot, nonce: bigint): boolean {
  return snapshot.latestNonce === nonce && snapshot.pendingNonce === nonce;
}

function assertTerminalRecoveryReceiptUnchanged(
  record: PreparationRecoveryRecord,
  receipt: CanonicalPreparationReceipt,
): void {
  if (record.receipt === undefined) {
    throw new Error("terminal wallet preparation recovery record has no receipt commitment");
  }
  if (
    receipt.txHash.toLowerCase() !== record.txHash.toLowerCase() ||
    receipt.walletAddress.toLowerCase() !== record.walletAddress.toLowerCase() ||
    receipt.nonce !== BigInt(record.nonce) ||
    receipt.action !== record.action ||
    receipt.blockNumber !== BigInt(record.receipt.blockNumber) ||
    receipt.blockHash.toLowerCase() !== record.receipt.blockHash.toLowerCase() ||
    receipt.status !== record.receipt.status ||
    (record.state === "FINAL" && receipt.status !== 1) ||
    (record.state === "FINAL_REVERTED" && receipt.status !== 0)
  ) {
    throw new Error("terminal wallet preparation receipt changed after restart");
  }
}

async function settleRecoveryReceipt(
  runtime: PreparationRecoveryRuntime,
  record: PreparationRecoveryRecord,
): Promise<CanonicalPreparationReceipt> {
  const receipt = await runtime.waitForReceipt(record);
  record = await runtime.journal.transition(
    record,
    receipt.status === 1 ? "FINAL" : "FINAL_REVERTED",
    runtime.now(),
    {
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      status: receipt.status,
    },
  );
  await runtime.vault.remove(record.vaultRef);
  if (receipt.status === 0) {
    throw new Error("wallet preparation transaction reverted canonically; recovery is terminal");
  }
  return receipt;
}

async function safelyClearRejected(
  runtime: PreparationRecoveryRuntime,
  record: PreparationRecoveryRecord,
): Promise<CanonicalPreparationReceipt | null> {
  const snapshot = await runtime.probe(record);
  if (snapshot.receipt !== null || snapshot.transactionKnown) {
    return settleRecoveryReceipt(runtime, record);
  }
  const nonce = BigInt(record.nonce);
  if (!nonceIsUnconsumed(snapshot, nonce)) {
    throw new Error(
      "rejected wallet preparation nonce was consumed without its canonical receipt; recovery is blocked",
    );
  }
  record = await runtime.journal.transition(record, "CLEARED", runtime.now());
  await runtime.vault.remove(record.vaultRef);
  return null;
}

/**
 * Resolve every durable preparation record before any new plan or executor readiness check.
 * UNKNOWN work is replayed byte-for-byte only when both latest and pending nonce remain unchanged.
 */
export async function recoverPreparationRecords(
  runtime: PreparationRecoveryRuntime,
): Promise<readonly CanonicalPreparationReceipt[]> {
  const receipts: CanonicalPreparationReceipt[] = [];
  const records = await runtime.journal.list();
  const unresolved = records.filter((record) => !terminalRecoveryStates.has(record.state));
  const activeVaultReferences = new Set(unresolved.map((record) => record.vaultRef));
  for (const terminal of records.filter(
    (record) => record.state === "FINAL" || record.state === "FINAL_REVERTED",
  )) {
    const receipt = await runtime.waitForReceipt(terminal);
    assertTerminalRecoveryReceiptUnchanged(terminal, receipt);
    receipts.push(receipt);
    // A crash after terminal journal commit but before vault deletion leaves harmless encrypted
    // bytes behind. A later CLEARED attempt may safely reuse the same signed bytes/hash, so an
    // older terminal record must never delete a vault payload owned by that newer active attempt.
    if (!activeVaultReferences.has(terminal.vaultRef)) {
      await runtime.vault.remove(terminal.vaultRef);
    }
    if (terminal.state === "FINAL_REVERTED") {
      throw new Error("historical wallet preparation transaction reverted canonically");
    }
  }
  for (const cleared of records.filter((record) => record.state === "CLEARED")) {
    if (!activeVaultReferences.has(cleared.vaultRef)) {
      await runtime.vault.remove(cleared.vaultRef);
    }
  }

  for (let record of unresolved) {
    const snapshot = await runtime.probe(record);
    if (snapshot.receipt !== null) {
      receipts.push(await settleRecoveryReceipt(runtime, record));
      continue;
    }
    if (snapshot.transactionKnown) {
      record = await runtime.journal.transition(record, "KNOWN", runtime.now());
      receipts.push(await settleRecoveryReceipt(runtime, record));
      continue;
    }

    const nonce = BigInt(record.nonce);
    if (!nonceIsUnconsumed(snapshot, nonce)) {
      throw new Error(
        "wallet preparation nonce was consumed without its canonical receipt; recovery is blocked",
      );
    }
    if (!(await runtime.vault.exists(record.vaultRef))) {
      if (record.state !== "PREPARED" && record.state !== "REJECTED") {
        throw new Error("unresolved wallet preparation is missing its encrypted same-raw payload");
      }
      await runtime.journal.transition(record, "CLEARED", runtime.now());
      continue;
    }

    const raw = await runtime.vault.get(record.vaultRef, record.txHash);
    const actualHash = keccak256(getBytes(raw));
    if (actualHash.toLowerCase() !== record.txHash.toLowerCase()) {
      throw new Error("wallet preparation vault returned a different signed payload");
    }
    record = await runtime.journal.transition(record, "BROADCASTING", runtime.now());
    // This is intentionally the final awaited check before the network write.
    await runtime.assertMarkers();
    const result = await runtime.broadcaster.broadcast(raw);
    if (result.txHash.toLowerCase() !== record.txHash.toLowerCase()) {
      throw new Error("same-raw preparation recovery returned a different transaction hash");
    }
    record = await runtime.journal.transition(record, result.state, runtime.now());
    if (result.state === "REJECTED") {
      const receipt = await safelyClearRejected(runtime, record);
      if (receipt !== null) receipts.push(receipt);
      continue;
    }
    receipts.push(await settleRecoveryReceipt(runtime, record));
  }
  await assertNoUnresolvedPreparationRecords(runtime.journal);
  return Object.freeze(receipts);
}

async function probePreparationRecord(
  requester: JsonRpcRequester,
  record: PreparationRecoveryRecord,
): Promise<PreparationRecoveryProbeSnapshot> {
  const [receipt, transaction, latestRaw, pendingRaw] = await Promise.all([
    readProductionReceipt(requester, record.txHash),
    requester.request<unknown | null>("eth_getTransactionByHash", [record.txHash]),
    requester.request<string>("eth_getTransactionCount", [record.walletAddress, "latest"]),
    requester.request<string>("eth_getTransactionCount", [record.walletAddress, "pending"]),
  ]);
  return Object.freeze({
    receipt,
    transactionKnown: transaction !== null,
    latestNonce: hexToBigInt("latest nonce", latestRaw),
    pendingNonce: hexToBigInt("pending nonce", pendingRaw),
  });
}

function signedTxVaultRuntime(vault: SignedTxVault): PreparationRecoveryVault {
  return Object.freeze({
    exists: async (reference: string) => {
      try {
        await access(reference);
        return true;
      } catch {
        return false;
      }
    },
    get: async (reference: string, expectedTxHash: Hex32) => vault.get(reference, expectedTxHash),
    remove: async (reference: string) => vault.remove(reference),
  });
}

async function assertPreparationBroadcastMarkers(authorizationExpiresAt: string): Promise<void> {
  if (Date.now() >= Date.parse(authorizationExpiresAt)) {
    throw new Error("production authorization expired during wallet preparation");
  }
  await Promise.all([assertPaidRpcApproved(), assertProductionArmApproved()]);
}

interface PreparationFeeBlock {
  readonly number?: unknown;
  readonly hash?: unknown;
  readonly baseFeePerGas?: unknown;
}

function preparationBlockQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string") throw new TypeError(`${label} must be an RPC quantity`);
  return hexToBigInt(label, value);
}

function preparationBlockHash(value: unknown, label: string): Hex32 {
  if (typeof value !== "string" || !isHexString(value, 32)) {
    throw new TypeError(`${label} must be a 32-byte hex value`);
  }
  return value as Hex32;
}

export function assertAuthorizedPreparationFeeHeadroom(input: {
  readonly baseFeePerGasWei: bigint;
  readonly maximumPriorityFeePerGasWei: bigint;
  readonly maximumFeePerGasWei: bigint;
}): void {
  if (
    input.baseFeePerGasWei < 0n ||
    input.maximumPriorityFeePerGasWei < 0n ||
    input.maximumFeePerGasWei <= 0n
  ) {
    throw new RangeError("wallet preparation fee values are invalid");
  }
  if (input.baseFeePerGasWei + input.maximumPriorityFeePerGasWei > input.maximumFeePerGasWei) {
    throw new PreparationFeeDeferred(
      "wallet preparation deferred: current base fee plus priority fee exceeds the owner-authorized maximum fee",
    );
  }
}

/** Read and bind the current fee to the same canonical block number/hash before local signing. */
export async function readCanonicalPreparationFeeSnapshot(
  requester: JsonRpcRequester,
): Promise<CanonicalPreparationFeeSnapshot> {
  const latest = await requester.request<PreparationFeeBlock | null>("eth_getBlockByNumber", [
    "latest",
    false,
  ]);
  if (latest === null) throw new PreparationFeeDeferred("latest fee block is unavailable");
  const blockNumber = preparationBlockQuantity(latest.number, "latest block number");
  const blockHash = preparationBlockHash(latest.hash, "latest block hash");
  const baseFeePerGasWei = preparationBlockQuantity(latest.baseFeePerGas, "latest base fee");
  const canonical = await requester.request<PreparationFeeBlock | null>("eth_getBlockByNumber", [
    quantityToHex(blockNumber),
    false,
  ]);
  if (canonical === null) {
    throw new PreparationFeeDeferred("canonical fee block is unavailable");
  }
  if (
    preparationBlockQuantity(canonical.number, "canonical block number") !== blockNumber ||
    preparationBlockHash(canonical.hash, "canonical block hash").toLowerCase() !==
      blockHash.toLowerCase() ||
    preparationBlockQuantity(canonical.baseFeePerGas, "canonical base fee") !== baseFeePerGasWei
  ) {
    throw new PreparationFeeDeferred("latest fee block changed before wallet preparation signing");
  }
  return Object.freeze({ blockNumber, blockHash, baseFeePerGasWei });
}

export async function signPreparationTransactionAfterLiveGuards(input: {
  readonly requester: JsonRpcRequester;
  readonly priorReceipts: readonly CanonicalPreparationReceipt[];
  readonly walletAddress: Address;
  readonly expectedNonce: bigint;
  readonly maximumFeePerGasWei: bigint;
  readonly maximumPriorityFeePerGasWei: bigint;
  readonly assertMarkers: () => Promise<void>;
  readonly signTransaction: () => Promise<Hex>;
}): Promise<Hex> {
  // Every next step re-reads every prior receipt, its block hash/status/gas, and the advanced nonce.
  await assertPriorPreparationReceiptsCanonical(input.requester, input.priorReceipts);
  const [latestRaw, pendingRaw] = await Promise.all([
    input.requester.request<string>("eth_getTransactionCount", [input.walletAddress, "latest"]),
    input.requester.request<string>("eth_getTransactionCount", [input.walletAddress, "pending"]),
  ]);
  const latestNonce = hexToBigInt("latest nonce", latestRaw);
  const pendingNonce = hexToBigInt("pending nonce", pendingRaw);
  if (latestNonce !== input.expectedNonce || pendingNonce !== input.expectedNonce) {
    throw new Error("wallet nonce changed after the all-wallet preparation plan");
  }
  const fee = await readCanonicalPreparationFeeSnapshot(input.requester);
  assertAuthorizedPreparationFeeHeadroom({
    baseFeePerGasWei: fee.baseFeePerGasWei,
    maximumPriorityFeePerGasWei: input.maximumPriorityFeePerGasWei,
    maximumFeePerGasWei: input.maximumFeePerGasWei,
  });
  // This is the final awaited operation after receipt/nonce/fee RPCs and before local signing.
  await input.assertMarkers();
  const raw = await input.signTransaction();
  if (!isHexString(raw) || raw === "0x") {
    throw new TypeError("wallet preparation signer returned invalid transaction bytes");
  }
  return raw;
}

async function executeAction(input: {
  readonly signer: Wallet;
  readonly walletAddress: Address;
  readonly action: StonkSafeLaunchPreparationAction;
  readonly expectedNonce: bigint;
  readonly maximumFeePerGasWei: bigint;
  readonly maximumPriorityFeePerGasWei: bigint;
  readonly authorizationExpiresAt: string;
  readonly requester: JsonRpcRequester;
  readonly broadcaster: SameRawBroadcaster;
  readonly vault: SignedTxVault;
  readonly vaultDirectory: string;
  readonly journal: PreparationRecoveryJournal;
  readonly priorReceipts: readonly CanonicalPreparationReceipt[];
  readonly evidencePath: string;
}): Promise<CanonicalPreparationReceipt> {
  if (input.expectedNonce > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("wallet nonce exceeds the safe transaction range");
  }
  const raw = await signPreparationTransactionAfterLiveGuards({
    requester: input.requester,
    priorReceipts: input.priorReceipts,
    walletAddress: input.walletAddress,
    expectedNonce: input.expectedNonce,
    maximumFeePerGasWei: input.maximumFeePerGasWei,
    maximumPriorityFeePerGasWei: input.maximumPriorityFeePerGasWei,
    assertMarkers: async () => assertPreparationBroadcastMarkers(input.authorizationExpiresAt),
    signTransaction: async () =>
      input.signer.signTransaction({
        type: 2,
        chainId: 4_663n,
        nonce: Number(input.expectedNonce),
        to: input.action.target,
        data: input.action.calldata,
        value: input.action.valueRaw,
        gasLimit: input.action.gasLimit,
        maxFeePerGas: input.maximumFeePerGasWei,
        maxPriorityFeePerGas: input.maximumPriorityFeePerGasWei,
      }) as Promise<Hex>,
  });
  const txHash = keccak256(getBytes(raw)) as Hex32;
  const vaultRef = signedTxVaultReference(input.vaultDirectory, txHash);
  let recovery = await input.journal.create({
    txHash,
    walletAddress: input.walletAddress,
    nonce: input.expectedNonce.toString(),
    action: input.action.kind,
    vaultRef,
    createdAt: new Date().toISOString(),
  });
  const actualVaultRef = await input.vault.put(raw as Hex, new Date().toISOString());
  if (resolve(actualVaultRef) !== resolve(vaultRef)) {
    throw new Error("wallet preparation vault reference is not deterministic");
  }
  recovery = await input.journal.transition(recovery, "STORED", new Date().toISOString());
  recovery = await input.journal.transition(recovery, "BROADCASTING", new Date().toISOString());
  // Revalidate both root-owned markers immediately before every network write.
  await assertPreparationBroadcastMarkers(input.authorizationExpiresAt);
  const result = await input.broadcaster.broadcast(raw as Hex);
  if (result.txHash.toLowerCase() !== txHash.toLowerCase()) {
    throw new Error("wallet preparation broadcaster returned a different transaction hash");
  }
  recovery = await input.journal.transition(recovery, result.state, new Date().toISOString());
  await appendEvidence(input.evidencePath, {
    event: "BROADCAST",
    observedAt: new Date().toISOString(),
    walletAddress: input.walletAddress,
    nonce: input.expectedNonce,
    action: input.action.kind,
    txHash,
    vaultRef,
    transportState: result.state,
    providers: result.outcomes.map((outcome) => ({
      providerId: outcome.providerId,
      result: outcome.result,
    })),
  });
  if (result.state === "REJECTED") {
    const recovered = await safelyClearRejected(
      {
        journal: input.journal,
        vault: signedTxVaultRuntime(input.vault),
        probe: async (record) => probePreparationRecord(input.requester, record),
        waitForReceipt: async (record) =>
          waitForCanonicalReceipt({
            requester: input.requester,
            txHash: record.txHash,
            walletAddress: record.walletAddress,
            nonce: BigInt(record.nonce),
            action: record.action,
            timeoutMs: RECEIPT_TIMEOUT_MS,
            pollMs: RECEIPT_POLL_MS,
          }),
        broadcaster: input.broadcaster,
        assertMarkers: async () => assertPreparationBroadcastMarkers(input.authorizationExpiresAt),
        now: () => new Date().toISOString(),
      },
      recovery,
    );
    if (recovered === null) {
      throw new Error("wallet preparation broadcast was deterministically rejected and cleared");
    }
    return recovered;
  }
  const receipt = await waitForCanonicalReceipt({
    requester: input.requester,
    txHash,
    walletAddress: input.walletAddress,
    nonce: input.expectedNonce,
    action: input.action.kind,
    timeoutMs: RECEIPT_TIMEOUT_MS,
    pollMs: RECEIPT_POLL_MS,
  });
  recovery = await input.journal.transition(
    recovery,
    receipt.status === 1 ? "FINAL" : "FINAL_REVERTED",
    new Date().toISOString(),
    {
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      status: receipt.status,
    },
  );
  await appendEvidence(input.evidencePath, {
    event: "CANONICAL_RECEIPT",
    observedAt: new Date().toISOString(),
    ...receipt,
  });
  await input.vault.remove(recovery.vaultRef);
  if (receipt.status === 0) {
    throw new Error("wallet preparation transaction reverted canonically; journal is terminal");
  }
  return receipt;
}

function logRedacted(value: object): void {
  process.stdout.write(redactedJson(value));
}

/** Deliberate, one-shot production command. Importing this module performs no I/O. */
export async function runStonkSafeLaunchWalletPreparation(): Promise<void> {
  // Both root-owned markers are checked before any RPC or signer credential is read.
  await Promise.all([assertPaidRpcApproved(), assertProductionArmApproved()]);
  const [walletBundle, rpcHttp, sequencerHttp, vaultKey] = await Promise.all([
    loadProductionWalletSigners(),
    readSystemdCredential("rpc_http"),
    readSystemdCredential("sequencer_http"),
    loadVaultKey(),
  ]);
  const { profile, authorization } = await loadStonkSafeLaunchProfileAndAuthorization(
    walletBundle.manifest,
  );
  const canonical = new HttpJsonRpcClient({
    providerId: "wallet-preparation-canonical",
    url: rpcHttp,
    timeoutMs: 4_000,
  });
  const sequencer = new HttpJsonRpcClient({
    providerId: "wallet-preparation-sequencer",
    url: sequencerHttp,
    timeoutMs: 2_000,
  });
  await verifyStonkSafeLaunchQuotedProfile(canonical, CLOCKIN_WETH_SAFE_LAUNCH_PROFILE, "latest");
  const maximumFeePerGasWei = BigInt(profile.entry.maximumFeePerGasWei);
  const maximumPriorityFeePerGasWei = BigInt(profile.entry.maximumPriorityFeePerGasWei);
  const gas = Object.freeze({
    depositGasLimit: DEPOSIT_GAS_LIMIT,
    approvalGasLimit: APPROVAL_GAS_LIMIT,
    entryGasLimit: ENTRY_GAS_LIMIT,
    maximumFeePerGasWei,
    gasSafetyMarginBps: GAS_SAFETY_MARGIN_BPS,
  });
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

  const stateDirectory = process.env.CLOCKIN_STATE_DIR?.trim() || DEFAULT_STATE_DIRECTORY;
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const vaultDirectory = join(stateDirectory, "vault");
  const vault = new SignedTxVault(vaultDirectory, vaultKey);
  const journal = new PreparationRecoveryJournal(join(stateDirectory, "weth-preparation-recovery"));
  const evidencePath = join(
    stateDirectory,
    `weth-preparation-${new Date().toISOString().replaceAll(":", "-")}.ndjson`,
  );
  const receipts: CanonicalPreparationReceipt[] = [
    ...(await recoverPreparationRecords({
      journal,
      vault: signedTxVaultRuntime(vault),
      probe: async (record) => probePreparationRecord(canonical, record),
      waitForReceipt: async (record) =>
        waitForCanonicalReceipt({
          requester: canonical,
          txHash: record.txHash,
          walletAddress: record.walletAddress,
          nonce: BigInt(record.nonce),
          action: record.action,
          timeoutMs: RECEIPT_TIMEOUT_MS,
          pollMs: RECEIPT_POLL_MS,
        }),
      broadcaster,
      assertMarkers: async () => assertPreparationBroadcastMarkers(authorization.expiresAt),
      now: () => new Date().toISOString(),
    })),
  ];
  await assertNoUnresolvedPreparationRecords(journal);
  await appendEvidence(evidencePath, {
    event: "RECOVERY_RESOLVED",
    observedAt: new Date().toISOString(),
    recoveredReceiptCount: receipts.length,
    recoveredTxHashes: receipts.map((receipt) => receipt.txHash),
  });

  // Only after recovery is fully resolved may a fresh price and all-wallet plan be created.
  const price = await new ProductionPriceCache().refresh();
  const bufferedBatchWethRaw = bufferedWethPrincipal(price.batchValueWei, PRINCIPAL_BUFFER_BPS);
  const initialReadiness = await inspectStonkSafeLaunchWalletReadiness(
    canonical,
    walletBundle.manifest,
    {
      batchWethRaw: bufferedBatchWethRaw,
      entryGasLimit: ENTRY_GAS_LIMIT,
      maximumFeePerGasWei,
      gasSafetyMarginBps: GAS_SAFETY_MARGIN_BPS,
    },
  );
  const batch = planStonkSafeLaunchPreparationBatch({
    readiness: initialReadiness,
    nominalBatchWethRaw: price.batchValueWei,
    principalBufferBps: PRINCIPAL_BUFFER_BPS,
    gas,
  });
  assertPreparationCanBroadcast({
    batch,
    authorizationExpiresAt: authorization.expiresAt,
    nowMs: Date.now(),
  });
  const allInRisk = assertPreparationAllInRiskWithinCap({
    batch,
    usdMicrosPerEth: price.primary.usdMicrosPerEth,
    allInRiskCapUsdMicros: CLOCKIN_POLICY_V2.allInRiskCapUsdMicros,
    completedReceipts: receipts,
  });
  await appendEvidence(evidencePath, {
    event: "PLAN_FROZEN",
    observedAt: new Date().toISOString(),
    host: hostname(),
    profileHash: profile.profileHash,
    authorizationId: authorization.authorizationId,
    priceSnapshotId: price.snapshotId,
    nominalBatchWethRaw: batch.nominalBatchWethRaw,
    bufferedBatchWethRaw: batch.bufferedBatchWethRaw,
    principalBufferBps: batch.principalBufferBps,
    bufferedPrincipalUsdMicros: allInRisk.bufferedPrincipalUsdMicros,
    completedPreparationGasWei: allInRisk.completedPreparationGasWei,
    completedPreparationGasUsdMicros: allInRisk.completedPreparationGasUsdMicros,
    remainingMaximumGasUsdMicros: allInRisk.remainingMaximumGasUsdMicros,
    maximumGasUsdMicros: allInRisk.maximumGasUsdMicros,
    allInUsdMicros: allInRisk.totalUsdMicros,
    allInCapUsdMicros: allInRisk.capUsdMicros,
    walletCount: batch.wallets.length,
    wallets: batch.wallets.map((plan) => ({
      walletAddress: plan.walletAddress,
      actionKinds: plan.actions.map((action) => action.kind),
      nativeBalanceWei: plan.nativeBalanceWei,
      totalNativeRequiredWei: plan.totalNativeRequiredWei,
      executable: plan.executable,
    })),
  });

  const signerByAddress = new Map(
    walletBundle.signers.map((binding) => [binding.entry.address.toLowerCase(), binding.signer]),
  );
  for (const plan of batch.wallets) {
    const signer = signerByAddress.get(plan.walletAddress.toLowerCase());
    if (signer === undefined) throw new Error("planned wallet has no signer credential");
    const initialRow = readinessRowByAddress(initialReadiness, plan.walletAddress);
    let expectedNonce = initialRow.pendingNonce;
    for (const action of plan.actions) {
      const receipt = await executeAction({
        signer,
        walletAddress: plan.walletAddress,
        action,
        expectedNonce,
        maximumFeePerGasWei,
        maximumPriorityFeePerGasWei,
        authorizationExpiresAt: authorization.expiresAt,
        requester: canonical,
        broadcaster,
        vault,
        vaultDirectory,
        journal,
        priorReceipts: receipts,
        evidencePath,
      });
      receipts.push(receipt);
      expectedNonce += 1n;
    }
  }
  await assertNoUnresolvedPreparationRecords(journal);
  await assertPriorPreparationReceiptsCanonical(canonical, receipts);
  const finalReadiness = await inspectStonkSafeLaunchWalletReadiness(
    canonical,
    walletBundle.manifest,
    {
      batchWethRaw: batch.bufferedBatchWethRaw,
      entryGasLimit: ENTRY_GAS_LIMIT,
      maximumFeePerGasWei,
      gasSafetyMarginBps: GAS_SAFETY_MARGIN_BPS,
    },
  );
  if (
    !finalReadiness.allLanesArmed ||
    finalReadiness.rows.some((row) => row.wethAllowanceRaw !== batch.bufferedBatchWethRaw)
  ) {
    throw new Error("final WETH readiness is not 10/10 with exact buffered allowances");
  }
  const finalBatch = planStonkSafeLaunchPreparationBatch({
    readiness: finalReadiness,
    nominalBatchWethRaw: price.batchValueWei,
    principalBufferBps: PRINCIPAL_BUFFER_BPS,
    gas,
  });
  if (finalBatch.wallets.some((wallet) => wallet.actions.length !== 0)) {
    throw new Error("final WETH readiness still requires a preparation action");
  }
  const finalAllInRisk = assertPreparationAllInRiskWithinCap({
    batch: finalBatch,
    usdMicrosPerEth: price.primary.usdMicrosPerEth,
    allInRiskCapUsdMicros: CLOCKIN_POLICY_V2.allInRiskCapUsdMicros,
    completedReceipts: receipts,
  });
  await appendEvidence(evidencePath, {
    event: "CANONICAL_PREPARATION_RECEIPT_LEDGER",
    observedAt: new Date().toISOString(),
    receiptCount: receipts.length,
    completedPreparationGasWei: finalAllInRisk.completedPreparationGasWei,
    completedPreparationGasUsdMicros: finalAllInRisk.completedPreparationGasUsdMicros,
    remainingMaximumGasUsdMicros: finalAllInRisk.remainingMaximumGasUsdMicros,
    allInUsdMicros: finalAllInRisk.totalUsdMicros,
    allInCapUsdMicros: finalAllInRisk.capUsdMicros,
    receipts: receipts.map((receipt) => ({
      txHash: receipt.txHash,
      walletAddress: receipt.walletAddress,
      nonce: receipt.nonce,
      action: receipt.action,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      status: receipt.status,
    })),
  });
  await appendEvidence(evidencePath, {
    event: "READINESS_10_OF_10",
    observedAt: new Date().toISOString(),
    blockNumber: finalReadiness.blockNumber,
    readyWallets: finalReadiness.readyWallets,
    wallets: finalReadiness.rows.map((row) => ({
      walletId: row.walletId,
      address: row.address,
      nativeBalanceWei: row.nativeBalanceWei,
      wethBalanceRaw: row.wethBalanceRaw,
      wethAllowanceRaw: row.wethAllowanceRaw,
      latestNonce: row.latestNonce,
      pendingNonce: row.pendingNonce,
    })),
  });
  logRedacted({
    event: "WETH_PREPARATION_COMPLETE",
    evidencePath,
    receiptCount: receipts.length,
    completedPreparationGasWei: finalAllInRisk.completedPreparationGasWei,
    allInUsdMicros: finalAllInRisk.totalUsdMicros,
    txHashes: receipts.map((receipt) => receipt.txHash),
    readyWallets: finalReadiness.readyWallets,
    wallets: finalReadiness.rows.map((row) => ({
      walletId: row.walletId,
      address: row.address,
      nativeBalanceWei: row.nativeBalanceWei,
      wethBalanceRaw: row.wethBalanceRaw,
      wethAllowanceRaw: row.wethAllowanceRaw,
    })),
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runStonkSafeLaunchWalletPreparation().catch((error: unknown) => {
    logRedacted({
      event:
        error instanceof PreparationFeeDeferred
          ? "WETH_PREPARATION_DEFERRED_FEE_CAP"
          : "WETH_PREPARATION_FAILED",
      recoveryEvidence: "see state NDJSON",
    });
    process.exitCode = 1;
  });
}
