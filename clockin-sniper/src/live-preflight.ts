import { Interface } from "ethers";

import type { LiveRuntimeConfig } from "./live-config.js";
import { JsonRpcPoolObserver } from "./pool-observer.js";
import { decodeUint256, hexToBigInt, quantityToHex } from "./rpc/hex.js";
import { verifyRobinhoodMainnet, type RobinhoodRpcIdentity } from "./rpc/robinhood.js";
import type { Hex, JsonRpcRequester } from "./rpc/types.js";

const ERC20 = new Interface(["function balanceOf(address owner) view returns (uint256)"]);

export interface LivePreflightResult {
  readonly identity: RobinhoodRpcIdentity;
  readonly latestNonce: bigint;
  readonly pendingNonce: bigint;
  readonly nativeBalanceWei: bigint;
  readonly tokenBalanceBefore: bigint;
  readonly requiredWorstCaseWei: bigint;
  readonly baseFeePerGasWei: bigint;
  readonly observedFeeBps: number;
  readonly observedBlockNumber: bigint;
}

async function requireContractCode(
  requester: JsonRpcRequester,
  name: string,
  address: Hex,
  blockTag: Hex,
): Promise<void> {
  const code = await requester.request<string>("eth_getCode", [address, blockTag]);
  if (code === "0x" || code === "0x0") {
    throw new Error(`${name} has no contract code on Robinhood mainnet`);
  }
}

export async function readErc20Balance(
  requester: JsonRpcRequester,
  tokenAddress: Hex,
  owner: Hex,
  blockTag: string = "latest",
): Promise<bigint> {
  const data = ERC20.encodeFunctionData("balanceOf", [owner]);
  const result = await requester.request<string>("eth_call", [
    { to: tokenAddress, data },
    blockTag,
  ]);
  return decodeUint256("balanceOf result", result);
}

export async function runLivePreflight(
  requester: JsonRpcRequester,
  config: LiveRuntimeConfig,
  now: () => number = Date.now,
): Promise<LivePreflightResult> {
  const expiresAtMs = config.plan.windowStartedAtMs + config.plan.windowDurationMs;
  if (now() > expiresAtMs) {
    throw new Error("live launch window has already expired");
  }
  const identity = await verifyRobinhoodMainnet(requester);
  const blockTag = quantityToHex(identity.blockNumber);
  await Promise.all([
    requireContractCode(requester, "CLOCKIN_BUY_TO", config.buyTo, blockTag),
    requireContractCode(requester, "CLOCKIN_TOKEN_ADDRESS", config.tokenAddress, blockTag),
    requireContractCode(requester, "CLOCKIN_POOL_ADDRESS", config.pool.poolAddress, blockTag),
  ]);

  const [latestNonceHex, pendingNonceHex, balanceHex, tokenBalanceBefore, observation, block] =
    await Promise.all([
      requester.request<string>("eth_getTransactionCount", [
        config.expectedWalletAddress,
        blockTag,
      ]),
      requester.request<string>("eth_getTransactionCount", [
        config.expectedWalletAddress,
        "pending",
      ]),
      requester.request<string>("eth_getBalance", [config.expectedWalletAddress, "pending"]),
      readErc20Balance(requester, config.tokenAddress, config.beneficiaryAddress, blockTag),
      new JsonRpcPoolObserver(requester, config.pool).observeAt(identity.blockNumber),
      requester.request<{ readonly baseFeePerGas?: string }>("eth_getBlockByNumber", [
        blockTag,
        false,
      ]),
    ]);
  const latestNonce = hexToBigInt("latest nonce", latestNonceHex);
  const pendingNonce = hexToBigInt("pending nonce", pendingNonceHex);
  if (latestNonce !== pendingNonce) {
    throw new Error("live wallet has pending transactions; use a clean dedicated wallet");
  }
  const nativeBalanceWei = hexToBigInt("native balance", balanceHex);
  if (block.baseFeePerGas === undefined) {
    throw new Error("latest block has no baseFeePerGas; cannot validate EIP-1559 transaction");
  }
  const baseFeePerGasWei = hexToBigInt("baseFeePerGas", block.baseFeePerGas);
  if (config.maxFeePerGasWei < baseFeePerGasWei + config.maxPriorityFeePerGasWei) {
    throw new Error("configured max fee cannot cover current base fee plus priority fee");
  }
  const perBatchWorstCaseWei = config.batchValueWei + config.gasLimit * config.maxFeePerGasWei;
  const requiredWorstCaseWei = perBatchWorstCaseWei * BigInt(config.plan.batchCount);
  if (nativeBalanceWei < requiredWorstCaseWei) {
    throw new Error(
      `wallet balance is below the ${config.plan.batchCount}-tranche worst-case reservation`,
    );
  }

  return Object.freeze({
    identity,
    latestNonce,
    pendingNonce,
    nativeBalanceWei,
    tokenBalanceBefore,
    requiredWorstCaseWei,
    baseFeePerGasWei,
    observedFeeBps: observation.feeBps,
    observedBlockNumber: observation.blockNumber,
  });
}
