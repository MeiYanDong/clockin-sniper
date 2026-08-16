import type { FactoryLiveRuntimeConfig } from "./factory-live-config.js";
import { verifyFactoryRuntimeCode } from "./factory-discovery.js";
import { readErc20Balance } from "./live-preflight.js";
import {
  assertNativeQuotePool,
  readStonkPoolSnapshot,
  type StonkLaunchCandidate,
  type StonkPoolSnapshot,
} from "./stonk-launcher.js";
import { hexToBigInt, quantityToHex } from "./rpc/hex.js";
import { verifyRobinhoodMainnet, type RobinhoodRpcIdentity } from "./rpc/robinhood.js";
import type { Hex, JsonRpcRequester } from "./rpc/types.js";

export interface FactoryReadinessPreflight {
  readonly identity: RobinhoodRpcIdentity;
  readonly latestNonce: bigint;
  readonly pendingNonce: bigint;
  readonly nativeBalanceWei: bigint;
  readonly requiredWorstCaseWei: bigint;
  readonly baseFeePerGasWei: bigint;
  readonly factoryCodeHash: Hex;
}

export interface DiscoveredLaunchPreflight extends FactoryReadinessPreflight {
  readonly candidate: StonkLaunchCandidate;
  readonly pool: StonkPoolSnapshot;
  readonly launchTimestampSeconds: bigint;
  readonly windowStartedAtMs: number;
  readonly tokenBalanceBefore: bigint;
}

interface RpcBlock {
  readonly timestamp?: string;
  readonly baseFeePerGas?: string;
}

async function requireCode(
  requester: JsonRpcRequester,
  label: string,
  address: Hex,
  blockTag: Hex,
): Promise<void> {
  const code = await requester.request<string>("eth_getCode", [address, blockTag]);
  if (code === "0x" || code === "0x0") {
    throw new Error(`${label} has no runtime code at ${blockTag}`);
  }
}

async function readWalletReadiness(
  requester: JsonRpcRequester,
  config: FactoryLiveRuntimeConfig,
  identity: RobinhoodRpcIdentity,
): Promise<Omit<FactoryReadinessPreflight, "identity" | "factoryCodeHash">> {
  const blockTag = quantityToHex(identity.blockNumber);
  const [latestNonceHex, pendingNonceHex, balanceHex, block] = await Promise.all([
    requester.request<string>("eth_getTransactionCount", [config.expectedWalletAddress, blockTag]),
    requester.request<string>("eth_getTransactionCount", [config.expectedWalletAddress, "pending"]),
    requester.request<string>("eth_getBalance", [config.expectedWalletAddress, "pending"]),
    requester.request<RpcBlock>("eth_getBlockByNumber", [blockTag, false]),
  ]);
  const latestNonce = hexToBigInt("latest nonce", latestNonceHex);
  const pendingNonce = hexToBigInt("pending nonce", pendingNonceHex);
  if (latestNonce !== pendingNonce) {
    throw new Error("live wallet has pending transactions; use one clean dedicated wallet");
  }
  const nativeBalanceWei = hexToBigInt("native balance", balanceHex);
  if (block.baseFeePerGas === undefined) {
    throw new Error("latest block has no baseFeePerGas");
  }
  const baseFeePerGasWei = hexToBigInt("baseFeePerGas", block.baseFeePerGas);
  if (config.maxFeePerGasWei < baseFeePerGasWei + config.maxPriorityFeePerGasWei) {
    throw new Error("configured max fee cannot cover current base fee plus priority fee");
  }
  const requiredWorstCaseWei =
    (config.batchValueWei + config.gasLimit * config.maxFeePerGasWei) * BigInt(config.batchCount);
  if (nativeBalanceWei < requiredWorstCaseWei) {
    throw new Error("wallet balance is below the 10-tranche worst-case reservation");
  }
  return Object.freeze({
    latestNonce,
    pendingNonce,
    nativeBalanceWei,
    requiredWorstCaseWei,
    baseFeePerGasWei,
  });
}

export async function runFactoryReadinessPreflight(
  requester: JsonRpcRequester,
  config: FactoryLiveRuntimeConfig,
): Promise<FactoryReadinessPreflight> {
  const identity = await verifyRobinhoodMainnet(requester);
  const factoryCodeHash = await verifyFactoryRuntimeCode(
    requester,
    config.identityPolicy.factoryAddress,
    config.expectedFactoryCodeHash,
    quantityToHex(identity.blockNumber),
  );
  const wallet = await readWalletReadiness(requester, config, identity);
  return Object.freeze({ identity, factoryCodeHash, ...wallet });
}

export async function runDiscoveredLaunchPreflight(
  requester: JsonRpcRequester,
  config: FactoryLiveRuntimeConfig,
  candidate: StonkLaunchCandidate,
  expectedBaseNonce: bigint,
): Promise<DiscoveredLaunchPreflight> {
  const identity = await verifyRobinhoodMainnet(requester);
  const launchBlockTag = quantityToHex(candidate.blockNumber);
  const [factoryCodeHash, wallet, launchBlock, , , pool, tokenBalanceBefore] = await Promise.all([
    verifyFactoryRuntimeCode(
      requester,
      candidate.factoryAddress,
      config.expectedFactoryCodeHash,
      launchBlockTag,
    ),
    readWalletReadiness(requester, config, identity),
    requester.request<RpcBlock>("eth_getBlockByNumber", [launchBlockTag, false]),
    requireCode(requester, "discovered token", candidate.tokenAddress, launchBlockTag),
    requireCode(requester, "discovered pool", candidate.poolAddress, launchBlockTag),
    readStonkPoolSnapshot(requester, candidate.poolAddress, candidate.blockNumber),
    readErc20Balance(
      requester,
      candidate.tokenAddress,
      config.expectedWalletAddress,
      launchBlockTag,
    ),
  ]);
  if (wallet.pendingNonce !== expectedBaseNonce) {
    throw new Error("wallet nonce changed while Factory discovery was armed");
  }
  if (launchBlock.timestamp === undefined) throw new Error("launch block has no timestamp");
  const launchTimestampSeconds = hexToBigInt("launch timestamp", launchBlock.timestamp);
  const windowStartedAtMsBigInt = launchTimestampSeconds * 1_000n;
  if (windowStartedAtMsBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("launch timestamp exceeds JavaScript safe milliseconds");
  }
  const windowStartedAtMs = Number(windowStartedAtMsBigInt);
  assertNativeQuotePool(pool);
  if (!pool.inSniperWindow) {
    throw new Error("discovered launch is already outside the pool sniper window");
  }
  if (pool.currentFeeBps > config.maxInitialFeeBps) {
    throw new Error(
      `initial pool fee ${pool.currentFeeBps} bps exceeds configured ${config.maxInitialFeeBps} bps`,
    );
  }
  if (pool.currentFeeBps < config.expectedFloorFeeBps) {
    throw new Error("initial pool fee is below the configured floor");
  }

  return Object.freeze({
    identity,
    factoryCodeHash,
    ...wallet,
    candidate,
    pool,
    launchTimestampSeconds,
    windowStartedAtMs,
    tokenBalanceBefore,
  });
}
