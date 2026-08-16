import type { JsonRpcRequester } from "../rpc/types.js";
import type { WalletManifest } from "./wallet-manifest.js";

export interface WalletFundingPolicy {
  readonly batchValueWei: bigint;
  readonly entryGasLimit: bigint;
  readonly entryMaxFeePerGasWei: bigint;
  readonly approvalGasLimit: bigint;
  readonly sellGasLimit: bigint;
  readonly exitMaxFeePerGasWei: bigint;
  readonly safetyMarginWei: bigint;
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
  readonly totalRequiredWei: bigint;
  readonly shortfallWei: bigint;
  readonly principalReady: boolean;
  readonly entryGasReady: boolean;
  readonly exitGasReady: boolean;
  readonly nonceClean: boolean;
  readonly ready: boolean;
}

export interface WalletReadinessReport {
  readonly chainId: bigint;
  readonly rows: readonly WalletReadinessRow[];
  readonly principalReadyWallets: number;
  readonly entryGasReadyWallets: number;
  readonly exitGasReadyWallets: number;
  readonly nonceCleanWallets: number;
  readonly readyWallets: number;
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
  const chainId = quantity(await requester.request<string>("eth_chainId"));
  if (chainId !== 4663n) throw new Error(`expected chainId 4663, received ${chainId}`);
  const entryGasRequiredWei = policy.entryGasLimit * policy.entryMaxFeePerGasWei;
  const exitGasRequiredWei =
    (policy.approvalGasLimit + policy.sellGasLimit) * policy.exitMaxFeePerGasWei;
  const totalRequiredWei =
    policy.batchValueWei + entryGasRequiredWei + exitGasRequiredWei + policy.safetyMarginWei;

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
        totalRequiredWei,
        shortfallWei: balanceWei >= totalRequiredWei ? 0n : totalRequiredWei - balanceWei,
        principalReady,
        entryGasReady,
        exitGasReady,
        nonceClean,
        ready: principalReady && entryGasReady && exitGasReady && nonceClean,
      });
    }),
  );
  const expectedWalletCount = manifest.entries.length;
  const report: WalletReadinessReport = Object.freeze({
    chainId,
    rows: Object.freeze(rows),
    principalReadyWallets: rows.filter((row) => row.principalReady).length,
    entryGasReadyWallets: rows.filter((row) => row.entryGasReady).length,
    exitGasReadyWallets: rows.filter((row) => row.exitGasReady).length,
    nonceCleanWallets: rows.filter((row) => row.nonceClean).length,
    readyWallets: rows.filter((row) => row.ready).length,
    hotArmed: expectedWalletCount === 10 && rows.every((row) => row.ready),
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
