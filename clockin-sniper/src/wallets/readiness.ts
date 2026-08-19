import type { JsonRpcRequester } from "../rpc/types.js";
import type { WalletManifest } from "./wallet-manifest.js";

export interface WalletFundingPolicy {
  readonly batchValueWei: bigint;
  readonly entryGasLimit: bigint;
  readonly entryMaxFeePerGasWei: bigint;
  readonly approvalGasLimit: bigint;
  readonly sellGasLimit: bigint;
  readonly exitMaxFeePerGasWei: bigint;
  readonly maximumSellTransactions: number;
  readonly gasSafetyMarginBps: number;
  readonly aggregateAllInCapWei: bigint;
  readonly automaticTopUpAllowed: boolean;
}

export interface WalletReadinessRow {
  readonly walletId: string;
  readonly address: `0x${string}`;
  readonly balanceWei: bigint;
  readonly latestNonce: bigint;
  readonly pendingNonce: bigint;
  readonly unknownPending: boolean;
  readonly principalRequiredWei: bigint;
  readonly entryGasRequiredWei: bigint;
  readonly exitGasRequiredWei: bigint;
  readonly canaryGasSafetyMarginWei: bigint;
  readonly canaryTotalRequiredWei: bigint;
  readonly canaryShortfallWei: bigint;
  readonly gasSafetyMarginWei: bigint;
  readonly totalRequiredWei: bigint;
  readonly shortfallWei: bigint;
  readonly principalReady: boolean;
  readonly entryGasReady: boolean;
  readonly exitGasReady: boolean;
  readonly nonceClean: boolean;
  readonly canaryReady: boolean;
  readonly ready: boolean;
}

export interface WalletReadinessReport {
  readonly chainId: bigint;
  readonly rows: readonly WalletReadinessRow[];
  readonly principalReadyWallets: number;
  readonly entryGasReadyWallets: number;
  readonly exitGasReadyWallets: number;
  readonly nonceCleanWallets: number;
  readonly canaryReadyWallets: number;
  readonly laterLaneReadyWallets: number;
  readonly readyWallets: number;
  readonly canaryAggregateRequiredWei: bigint;
  readonly aggregateRequiredWei: bigint;
  readonly aggregateAllInCapWei: bigint;
  readonly allInCapReady: boolean;
  readonly automaticTopUpAllowed: false;
  readonly canaryArmed: boolean;
  readonly laterLanesArmed: boolean;
  readonly hotArmed: boolean;
}

function quantity(value: string): bigint {
  if (!/^0x[0-9a-f]+$/i.test(value)) throw new TypeError(`invalid RPC quantity ${value}`);
  return BigInt(value);
}

export async function inspectWalletReadiness(
  requester: JsonRpcRequester,
  manifest: WalletManifest,
  policy: WalletFundingPolicy,
): Promise<WalletReadinessReport> {
  if (
    policy.batchValueWei <= 0n ||
    policy.entryGasLimit <= 0n ||
    policy.entryMaxFeePerGasWei <= 0n ||
    policy.approvalGasLimit <= 0n ||
    policy.sellGasLimit <= 0n ||
    policy.exitMaxFeePerGasWei <= 0n ||
    policy.aggregateAllInCapWei <= 0n
  ) {
    throw new RangeError("wallet funding quantities must be positive");
  }
  if (
    !Number.isSafeInteger(policy.maximumSellTransactions) ||
    policy.maximumSellTransactions <= 0
  ) {
    throw new RangeError("maximum sell transactions must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(policy.gasSafetyMarginBps) ||
    policy.gasSafetyMarginBps < 0 ||
    policy.gasSafetyMarginBps > 10_000
  ) {
    throw new RangeError("gas safety margin must be between 0 and 10000 bps");
  }
  if (policy.automaticTopUpAllowed) {
    throw new Error("automatic wallet top-up is disabled by production policy");
  }
  const chainId = quantity(await requester.request<string>("eth_chainId"));
  if (chainId !== 4663n) throw new Error(`expected chainId 4663, received ${chainId}`);
  const entryGasRequiredWei = policy.entryGasLimit * policy.entryMaxFeePerGasWei;
  const exitGasRequiredWei =
    (policy.approvalGasLimit + policy.sellGasLimit * BigInt(policy.maximumSellTransactions)) *
    policy.exitMaxFeePerGasWei;
  const canaryGasSafetyMarginWei =
    (entryGasRequiredWei * BigInt(policy.gasSafetyMarginBps) + 9_999n) / 10_000n;
  const canaryTotalRequiredWei =
    policy.batchValueWei + entryGasRequiredWei + canaryGasSafetyMarginWei;
  const gasSafetyMarginWei =
    ((entryGasRequiredWei + exitGasRequiredWei) * BigInt(policy.gasSafetyMarginBps) + 9_999n) /
    10_000n;
  const totalRequiredWei =
    policy.batchValueWei + entryGasRequiredWei + exitGasRequiredWei + gasSafetyMarginWei;

  const rows = await Promise.all(
    manifest.entries.map(async (entry): Promise<WalletReadinessRow> => {
      const [balanceHex, latestHex, pendingHex] = await Promise.all([
        requester.request<string>("eth_getBalance", [entry.address, "latest"]),
        requester.request<string>("eth_getTransactionCount", [entry.address, "latest"]),
        requester.request<string>("eth_getTransactionCount", [entry.address, "pending"]),
      ]);
      const balanceWei = quantity(balanceHex);
      const latestNonce = quantity(latestHex);
      const pendingNonce = quantity(pendingHex);
      const unknownPending = pendingNonce !== latestNonce;
      const principalReady = balanceWei >= policy.batchValueWei;
      const entryGasReady = balanceWei >= policy.batchValueWei + entryGasRequiredWei;
      const exitGasReady = balanceWei >= totalRequiredWei;
      const nonceClean = !unknownPending;
      const canaryReady = balanceWei >= canaryTotalRequiredWei && nonceClean;
      return Object.freeze({
        walletId: entry.walletId,
        address: entry.address,
        balanceWei,
        latestNonce,
        pendingNonce,
        unknownPending,
        principalRequiredWei: policy.batchValueWei,
        entryGasRequiredWei,
        exitGasRequiredWei,
        canaryGasSafetyMarginWei,
        canaryTotalRequiredWei,
        canaryShortfallWei:
          balanceWei >= canaryTotalRequiredWei ? 0n : canaryTotalRequiredWei - balanceWei,
        gasSafetyMarginWei,
        totalRequiredWei,
        shortfallWei: balanceWei >= totalRequiredWei ? 0n : totalRequiredWei - balanceWei,
        principalReady,
        entryGasReady,
        exitGasReady,
        nonceClean,
        canaryReady,
        ready: principalReady && entryGasReady && exitGasReady && nonceClean,
      });
    }),
  );
  const expectedWalletCount = manifest.entries.length;
  const aggregateRequiredWei = totalRequiredWei * BigInt(expectedWalletCount);
  const canaryAggregateRequiredWei = canaryTotalRequiredWei;
  const allInCapReady = aggregateRequiredWei <= policy.aggregateAllInCapWei;
  const canaryReadyWallets = rows.filter((row) => row.canaryReady).length;
  const laterLaneReadyWallets = rows.slice(1).filter((row) => row.ready).length;
  const report: WalletReadinessReport = Object.freeze({
    chainId,
    rows: Object.freeze(rows),
    principalReadyWallets: rows.filter((row) => row.principalReady).length,
    entryGasReadyWallets: rows.filter((row) => row.entryGasReady).length,
    exitGasReadyWallets: rows.filter((row) => row.exitGasReady).length,
    nonceCleanWallets: rows.filter((row) => row.nonceClean).length,
    canaryReadyWallets,
    laterLaneReadyWallets,
    readyWallets: rows.filter((row) => row.ready).length,
    canaryAggregateRequiredWei,
    aggregateRequiredWei,
    aggregateAllInCapWei: policy.aggregateAllInCapWei,
    allInCapReady,
    automaticTopUpAllowed: false,
    canaryArmed:
      expectedWalletCount === 10 &&
      rows[0]?.canaryReady === true &&
      canaryAggregateRequiredWei <= policy.aggregateAllInCapWei,
    laterLanesArmed: expectedWalletCount === 10 && laterLaneReadyWallets === 9 && allInCapReady,
    hotArmed: expectedWalletCount === 10 && rows.every((row) => row.ready) && allInCapReady,
  });
  return report;
}

export function redactedReadinessJson(report: WalletReadinessReport): string {
  return JSON.stringify(
    report,
    (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}
