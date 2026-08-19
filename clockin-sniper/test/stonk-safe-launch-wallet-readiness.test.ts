import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Interface, Wallet } from "ethers";
import type { JsonRpcRequester } from "../src/rpc/types.js";
import { inspectStonkSafeLaunchWalletReadiness, type WalletManifest } from "../src/v2-index.js";

const erc20 = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
]);

function manifest(): WalletManifest {
  return Object.freeze({
    revision: 1,
    generatedAt: "2026-08-20T00:00:00.000Z",
    entries: Object.freeze(
      Array.from({ length: 10 }, (_, index) => {
        const wallet = new Wallet(`0x${String(index + 1).padStart(64, "0")}`);
        return Object.freeze({
          walletId: `entry-${String(index + 1).padStart(2, "0")}`,
          address: wallet.address as `0x${string}`,
          role: "CLOCKIN_ENTRY" as const,
          expectedChainId: 4_663 as const,
        });
      }),
    ),
  });
}

function requester(allowanceMissingFor?: string): JsonRpcRequester {
  return {
    providerId: "readiness-test",
    async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      if (method === "eth_chainId") return "0x1237" as T;
      if (method === "eth_blockNumber") return "0x64" as T;
      if (method === "eth_getTransactionCount") return "0x0" as T;
      if (method === "eth_getBalance") return "0x1bc16d674ec80000" as T;
      if (method === "eth_getCode") return "0x" as T;
      if (method === "eth_call") {
        const call = params[0] as { readonly data: string };
        if (call.data.startsWith(erc20.getFunction("balanceOf")?.selector ?? "never")) {
          return erc20.encodeFunctionResult("balanceOf", [5_000n]) as T;
        }
        if (call.data.startsWith(erc20.getFunction("allowance")?.selector ?? "never")) {
          const [owner] = erc20.decodeFunctionData("allowance", call.data);
          const amount =
            String(owner).toLowerCase() === allowanceMissingFor?.toLowerCase() ? 0n : 5_000n;
          return erc20.encodeFunctionResult("allowance", [amount]) as T;
        }
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

describe("quoted Safe Launch wallet readiness", () => {
  it("requires WETH, exact-pad allowance, native gas, clean nonce, and EOA for every lane", async () => {
    const report = await inspectStonkSafeLaunchWalletReadiness(requester(), manifest(), {
      batchWethRaw: 5_000n,
      entryGasLimit: 500_000n,
      maximumFeePerGasWei: 2_000_000_000n,
      gasSafetyMarginBps: 3_000,
    });
    assert.equal(report.chainId, 4_663n);
    assert.equal(report.readyWallets, 10);
    assert.equal(report.canaryArmed, true);
    assert.equal(report.allLanesArmed, true);
    assert.equal(report.aggregateWethRequiredRaw, 50_000n);
    assert.equal(report.rows[0]?.requiredNativeGasWei, 1_300_000_000_000_000n);
  });

  it("does not confuse an ETH balance with the required WETH allowance", async () => {
    const wallets = manifest();
    const blocked = wallets.entries[3]?.address;
    if (blocked === undefined) throw new Error("fixture wallet is missing");
    const report = await inspectStonkSafeLaunchWalletReadiness(requester(blocked), wallets, {
      batchWethRaw: 5_000n,
      entryGasLimit: 500_000n,
      maximumFeePerGasWei: 2_000_000_000n,
      gasSafetyMarginBps: 3_000,
    });
    assert.equal(report.rows[3]?.gasReady, true);
    assert.equal(report.rows[3]?.wethReady, true);
    assert.equal(report.rows[3]?.allowanceReady, false);
    assert.equal(report.rows[3]?.ready, false);
    assert.equal(report.readyWallets, 9);
    assert.equal(report.canaryArmed, true);
    assert.equal(report.allLanesArmed, false);
  });
});
