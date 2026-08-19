import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Interface } from "ethers";

import {
  planStonkSafeLaunchWalletPreparation,
  ROBINHOOD_WETH_ADDRESS,
  STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
} from "../src/v2-index.js";

const WALLET = "0x1111111111111111111111111111111111111111" as const;
const weth = new Interface([
  "function deposit() payable",
  "function approve(address spender,uint256 amount) returns (bool)",
]);
const gas = Object.freeze({
  depositGasLimit: 80_000n,
  approvalGasLimit: 100_000n,
  entryGasLimit: 500_000n,
  maximumFeePerGasWei: 2_000_000_000n,
  gasSafetyMarginBps: 3_000,
});

describe("WETH Safe Launch wallet preparation", () => {
  it("plans pre-wrap plus exact-pad approval before the hot path", () => {
    const plan = planStonkSafeLaunchWalletPreparation({
      walletAddress: WALLET,
      nativeBalanceWei: 10_000_000_000_000_000n,
      wethBalanceRaw: 1_000n,
      wethAllowanceRaw: 0n,
      batchWethRaw: 5_000n,
      gas,
    });
    assert.equal(plan.actions.length, 2);
    assert.equal(plan.actions[0]?.kind, "WRAP_WETH");
    assert.equal(plan.actions[0]?.target, ROBINHOOD_WETH_ADDRESS);
    assert.equal(plan.actions[0]?.valueRaw, 4_000n);
    assert.equal(plan.actions[0]?.calldata, weth.encodeFunctionData("deposit"));
    assert.equal(plan.actions[1]?.kind, "APPROVE_WETH");
    const approved = weth.decodeFunctionData("approve", plan.actions[1]?.calldata ?? "0x");
    assert.equal(
      String(approved[0]).toLowerCase(),
      STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS.toLowerCase(),
    );
    assert.equal(approved[1], 5_000n);
    assert.equal(plan.executable, true);
    assert.equal(plan.readyWithoutTransactions, false);
  });

  it("does not grant an infinite allowance and exposes native shortfall before signing", () => {
    const plan = planStonkSafeLaunchWalletPreparation({
      walletAddress: WALLET,
      nativeBalanceWei: 1n,
      wethBalanceRaw: 0n,
      wethAllowanceRaw: 0n,
      batchWethRaw: 5_000n,
      gas,
    });
    const approved = weth.decodeFunctionData("approve", plan.actions[1]?.calldata ?? "0x");
    assert.equal(approved[1], 5_000n);
    assert.equal(plan.executable, false);
    assert.ok(plan.nativeShortfallWei > 0n);
  });

  it("returns no preparation transactions when WETH and allowance are already ready", () => {
    const plan = planStonkSafeLaunchWalletPreparation({
      walletAddress: WALLET,
      nativeBalanceWei: 10_000_000_000_000_000n,
      wethBalanceRaw: 5_000n,
      wethAllowanceRaw: 5_000n,
      batchWethRaw: 5_000n,
      gas,
    });
    assert.deepEqual(plan.actions, []);
    assert.equal(plan.readyWithoutTransactions, true);
  });
});
