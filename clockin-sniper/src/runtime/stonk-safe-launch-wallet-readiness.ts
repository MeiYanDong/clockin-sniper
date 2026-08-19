import { StonkSafeLaunchQuotedAdapter } from "../adapters/stonk-safe-launch-quoted.js";
import type { Address } from "../core/canonical.js";
import { hexToBigInt } from "../rpc/hex.js";
import type { JsonRpcRequester } from "../rpc/types.js";
import type { WalletManifest } from "../wallets/wallet-manifest.js";

export interface StonkSafeLaunchWalletFundingPolicy {
  readonly batchWethRaw: bigint;
  readonly entryGasLimit: bigint;
  readonly maximumFeePerGasWei: bigint;
  readonly gasSafetyMarginBps: number;
}

export interface StonkSafeLaunchWalletReadinessRow {
  readonly walletId: string;
  readonly address: Address;
  readonly latestNonce: bigint;
  readonly pendingNonce: bigint;
  readonly nativeBalanceWei: bigint;
  readonly wethBalanceRaw: bigint;
  readonly wethAllowanceRaw: bigint;
  readonly requiredWethRaw: bigint;
  readonly requiredNativeGasWei: bigint;
  readonly eoaReady: boolean;
  readonly nonceReady: boolean;
  readonly gasReady: boolean;
  readonly wethReady: boolean;
  readonly allowanceReady: boolean;
  readonly ready: boolean;
}

export interface StonkSafeLaunchWalletReadinessReport {
  readonly chainId: 4663n;
  readonly blockNumber: bigint;
  readonly rows: readonly StonkSafeLaunchWalletReadinessRow[];
  readonly readyWallets: number;
  readonly aggregateWethRequiredRaw: bigint;
  readonly canaryArmed: boolean;
  readonly allLanesArmed: boolean;
}

export async function inspectStonkSafeLaunchWalletReadiness(
  requester: JsonRpcRequester,
  manifest: WalletManifest,
  policy: StonkSafeLaunchWalletFundingPolicy,
): Promise<StonkSafeLaunchWalletReadinessReport> {
  if (policy.batchWethRaw <= 0n || policy.entryGasLimit <= 0n || policy.maximumFeePerGasWei <= 0n) {
    throw new RangeError("Safe Launch funding quantities must be positive");
  }
  if (
    !Number.isSafeInteger(policy.gasSafetyMarginBps) ||
    policy.gasSafetyMarginBps < 0 ||
    policy.gasSafetyMarginBps > 10_000
  ) {
    throw new RangeError("gas safety margin must be in 0..10000 bps");
  }
  if (manifest.entries.length !== 10) throw new RangeError("ten entry wallets are required");
  const [chainIdRaw, blockRaw] = await Promise.all([
    requester.request<string>("eth_chainId"),
    requester.request<string>("eth_blockNumber"),
  ]);
  const chainId = hexToBigInt("eth_chainId", chainIdRaw);
  if (chainId !== 4_663n) throw new Error(`expected chainId 4663, received ${chainId}`);
  const blockNumber = hexToBigInt("eth_blockNumber", blockRaw);
  const adapter = new StonkSafeLaunchQuotedAdapter(requester);
  const baseGas = policy.entryGasLimit * policy.maximumFeePerGasWei;
  const gasMargin = (baseGas * BigInt(policy.gasSafetyMarginBps) + 9_999n) / 10_000n;
  const requiredNativeGasWei = baseGas + gasMargin;

  const rows = await Promise.all(
    manifest.entries.map(async (entry): Promise<StonkSafeLaunchWalletReadinessRow> => {
      const [latestRaw, pendingRaw, nativeRaw, code, spend] = await Promise.all([
        requester.request<string>("eth_getTransactionCount", [entry.address, "latest"]),
        requester.request<string>("eth_getTransactionCount", [entry.address, "pending"]),
        requester.request<string>("eth_getBalance", [entry.address, "latest"]),
        requester.request<string>("eth_getCode", [entry.address, "latest"]),
        adapter.spendReadiness(entry.address, policy.batchWethRaw, blockNumber),
      ]);
      const latestNonce = hexToBigInt("latest nonce", latestRaw);
      const pendingNonce = hexToBigInt("pending nonce", pendingRaw);
      const nativeBalanceWei = hexToBigInt("native balance", nativeRaw);
      const eoaReady = code === "0x";
      const nonceReady = latestNonce === pendingNonce;
      const gasReady = nativeBalanceWei >= requiredNativeGasWei;
      const wethReady = spend.balanceRaw >= policy.batchWethRaw;
      const allowanceReady = spend.allowanceRaw >= policy.batchWethRaw;
      return Object.freeze({
        walletId: entry.walletId,
        address: entry.address,
        latestNonce,
        pendingNonce,
        nativeBalanceWei,
        wethBalanceRaw: spend.balanceRaw,
        wethAllowanceRaw: spend.allowanceRaw,
        requiredWethRaw: policy.batchWethRaw,
        requiredNativeGasWei,
        eoaReady,
        nonceReady,
        gasReady,
        wethReady,
        allowanceReady,
        ready: eoaReady && nonceReady && gasReady && wethReady && allowanceReady,
      });
    }),
  );
  const readyWallets = rows.filter((row) => row.ready).length;
  return Object.freeze({
    chainId: 4_663n,
    blockNumber,
    rows: Object.freeze(rows),
    readyWallets,
    aggregateWethRequiredRaw: policy.batchWethRaw * 10n,
    canaryArmed: rows[0]?.ready === true,
    allLanesArmed: readyWallets === 10,
  });
}
