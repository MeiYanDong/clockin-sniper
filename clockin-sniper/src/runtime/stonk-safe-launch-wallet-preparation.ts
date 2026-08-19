import { Interface } from "ethers";

import {
  ROBINHOOD_WETH_ADDRESS,
  STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
} from "../adapters/stonk-safe-launch-quoted.js";
import type { Address } from "../core/canonical.js";
import type { Hex } from "../rpc/types.js";

const wethInterface = new Interface([
  "function deposit() payable",
  "function approve(address spender,uint256 amount) returns (bool)",
]);

export interface StonkSafeLaunchPreparationGasPolicy {
  readonly depositGasLimit: bigint;
  readonly approvalGasLimit: bigint;
  readonly entryGasLimit: bigint;
  readonly maximumFeePerGasWei: bigint;
  readonly gasSafetyMarginBps: number;
}

export interface StonkSafeLaunchPreparationAction {
  readonly kind: "WRAP_WETH" | "APPROVE_WETH";
  readonly target: Address;
  readonly valueRaw: bigint;
  readonly calldata: Hex;
  readonly gasLimit: bigint;
}

export interface StonkSafeLaunchWalletPreparationPlan {
  readonly walletAddress: Address;
  readonly batchWethRaw: bigint;
  readonly currentWethRaw: bigint;
  readonly currentAllowanceRaw: bigint;
  readonly wethDeficitRaw: bigint;
  readonly entryGasReserveWei: bigint;
  readonly preparationGasReserveWei: bigint;
  readonly totalNativeRequiredWei: bigint;
  readonly nativeBalanceWei: bigint;
  readonly nativeShortfallWei: bigint;
  readonly actions: readonly StonkSafeLaunchPreparationAction[];
  readonly readyWithoutTransactions: boolean;
  readonly executable: boolean;
}

function withMargin(value: bigint, bps: number): bigint {
  return value + (value * BigInt(bps) + 9_999n) / 10_000n;
}

export function planStonkSafeLaunchWalletPreparation(input: {
  readonly walletAddress: Address;
  readonly nativeBalanceWei: bigint;
  readonly wethBalanceRaw: bigint;
  readonly wethAllowanceRaw: bigint;
  readonly batchWethRaw: bigint;
  readonly gas: StonkSafeLaunchPreparationGasPolicy;
}): StonkSafeLaunchWalletPreparationPlan {
  if (
    input.nativeBalanceWei < 0n ||
    input.wethBalanceRaw < 0n ||
    input.wethAllowanceRaw < 0n ||
    input.batchWethRaw <= 0n ||
    input.gas.depositGasLimit <= 0n ||
    input.gas.approvalGasLimit <= 0n ||
    input.gas.entryGasLimit <= 0n ||
    input.gas.maximumFeePerGasWei <= 0n
  ) {
    throw new RangeError("wallet preparation values are invalid");
  }
  if (
    !Number.isSafeInteger(input.gas.gasSafetyMarginBps) ||
    input.gas.gasSafetyMarginBps < 0 ||
    input.gas.gasSafetyMarginBps > 10_000
  ) {
    throw new RangeError("preparation gas margin must be in 0..10000 bps");
  }
  const wethDeficitRaw =
    input.wethBalanceRaw >= input.batchWethRaw ? 0n : input.batchWethRaw - input.wethBalanceRaw;
  const needsApproval = input.wethAllowanceRaw < input.batchWethRaw;
  const actions: StonkSafeLaunchPreparationAction[] = [];
  if (wethDeficitRaw > 0n) {
    actions.push(
      Object.freeze({
        kind: "WRAP_WETH",
        target: ROBINHOOD_WETH_ADDRESS,
        valueRaw: wethDeficitRaw,
        calldata: wethInterface.encodeFunctionData("deposit") as Hex,
        gasLimit: input.gas.depositGasLimit,
      }),
    );
  }
  if (needsApproval) {
    actions.push(
      Object.freeze({
        kind: "APPROVE_WETH",
        target: ROBINHOOD_WETH_ADDRESS,
        valueRaw: 0n,
        calldata: wethInterface.encodeFunctionData("approve", [
          STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
          input.batchWethRaw,
        ]) as Hex,
        gasLimit: input.gas.approvalGasLimit,
      }),
    );
  }
  const entryGasReserveWei = withMargin(
    input.gas.entryGasLimit * input.gas.maximumFeePerGasWei,
    input.gas.gasSafetyMarginBps,
  );
  const preparationGasBaseWei = actions.reduce(
    (total, action) => total + action.gasLimit * input.gas.maximumFeePerGasWei,
    0n,
  );
  const preparationGasReserveWei = withMargin(preparationGasBaseWei, input.gas.gasSafetyMarginBps);
  const totalNativeRequiredWei = wethDeficitRaw + entryGasReserveWei + preparationGasReserveWei;
  const nativeShortfallWei =
    input.nativeBalanceWei >= totalNativeRequiredWei
      ? 0n
      : totalNativeRequiredWei - input.nativeBalanceWei;
  return Object.freeze({
    walletAddress: input.walletAddress,
    batchWethRaw: input.batchWethRaw,
    currentWethRaw: input.wethBalanceRaw,
    currentAllowanceRaw: input.wethAllowanceRaw,
    wethDeficitRaw,
    entryGasReserveWei,
    preparationGasReserveWei,
    totalNativeRequiredWei,
    nativeBalanceWei: input.nativeBalanceWei,
    nativeShortfallWei,
    actions: Object.freeze(actions),
    readyWithoutTransactions:
      wethDeficitRaw === 0n && !needsApproval && input.nativeBalanceWei >= entryGasReserveWei,
    executable: nativeShortfallWei === 0n,
  });
}
