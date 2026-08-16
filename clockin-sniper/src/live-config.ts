import { assertAddress, assertHex } from "./rpc/hex.js";
import type { Hex } from "./rpc/types.js";
import {
  loadObservationRuntimeConfig,
  type RuntimeEnvironment,
  type ObservationRuntimeConfig,
} from "./runtime-config.js";

function required(env: RuntimeEnvironment, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(env: RuntimeEnvironment, name: string, defaultValue?: number): number {
  const raw = env[name]?.trim();
  const value = raw === undefined || raw.length === 0 ? defaultValue : Number(raw);
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function positiveBigInt(env: RuntimeEnvironment, name: string): bigint {
  let value: bigint;
  try {
    value = BigInt(required(env, name));
  } catch {
    throw new TypeError(`${name} must be an integer string`);
  }
  if (value <= 0n) throw new RangeError(`${name} must be positive`);
  return value;
}

function address(env: RuntimeEnvironment, name: string): Hex {
  const value = required(env, name);
  assertAddress(name, value);
  return value;
}

function rpcUrls(env: RuntimeEnvironment, canonicalUrl: string): readonly string[] {
  const configured =
    env.ROBINHOOD_BROADCAST_RPC_URLS?.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0) ?? [];
  const unique = [...new Set(configured.length === 0 ? [canonicalUrl] : configured)];
  for (const value of unique) {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new RangeError("ROBINHOOD_BROADCAST_RPC_URLS must contain HTTP(S) URLs");
    }
  }
  return Object.freeze(unique);
}

export interface LiveRuntimeConfig extends ObservationRuntimeConfig {
  readonly wsRpcUrl: string;
  readonly privateKey: Hex;
  readonly expectedWalletAddress: Hex;
  readonly beneficiaryAddress: Hex;
  readonly buyTo: Hex;
  readonly tokenAddress: Hex;
  readonly buyCallData: Hex;
  readonly batchValueWei: bigint;
  readonly gasLimit: bigint;
  readonly maxFeePerGasWei: bigint;
  readonly maxPriorityFeePerGasWei: bigint;
  readonly broadcastRpcUrls: readonly string[];
  readonly receiptPollMs: number;
  readonly receiptTimeoutMs: number;
  readonly ledgerPath: string;
  readonly walletLeasePath: string;
}

/** Loads a real-funds configuration. There is intentionally no public fallback. */
export function loadLiveRuntimeConfig(env: RuntimeEnvironment): LiveRuntimeConfig {
  if (env.CLOCKIN_LIVE?.trim() !== "true") {
    throw new Error("CLOCKIN_LIVE=true is required for the real-funds executor");
  }

  const observation = loadObservationRuntimeConfig(env);
  if (observation.wsRpcUrl === null) {
    throw new Error("ROBINHOOD_WS_RPC_URL is required for the live executor");
  }
  const wsRpcUrl = observation.wsRpcUrl;
  if (observation.pollIntervalMs <= 0) {
    throw new RangeError("CLOCKIN_POLL_INTERVAL_MS must be positive");
  }
  if (
    observation.plan.batchCount !== 10 ||
    observation.plan.grossUsdMicrosPerBatch !== 5_000_000n ||
    observation.plan.windowDurationMs !== 120_000 ||
    observation.plan.startFeeBps !== 4_000 ||
    observation.plan.floorFeeBps !== 100
  ) {
    throw new Error("live strategy is fixed at 10 batches x 5U over a 4000-to-100 bps fee window");
  }

  const privateKey = required(env, "CLOCKIN_PRIVATE_KEY");
  assertHex("CLOCKIN_PRIVATE_KEY", privateKey);
  if (privateKey.length !== 66) {
    throw new RangeError("CLOCKIN_PRIVATE_KEY must be exactly 32 bytes");
  }

  const buyCallData = required(env, "CLOCKIN_BUY_CALL_DATA");
  assertHex("CLOCKIN_BUY_CALL_DATA", buyCallData, true);
  const maxFeePerGasWei = positiveBigInt(env, "CLOCKIN_MAX_FEE_PER_GAS_WEI");
  const maxPriorityFeePerGasWei = positiveBigInt(env, "CLOCKIN_MAX_PRIORITY_FEE_PER_GAS_WEI");
  if (maxPriorityFeePerGasWei > maxFeePerGasWei) {
    throw new RangeError("CLOCKIN_MAX_PRIORITY_FEE_PER_GAS_WEI exceeds max fee");
  }

  const expectedWalletAddress = address(env, "CLOCKIN_EXPECTED_WALLET_ADDRESS");
  const receiptPollMs = positiveInteger(env, "CLOCKIN_RECEIPT_POLL_MS", 250);
  const receiptTimeoutMs = positiveInteger(env, "CLOCKIN_RECEIPT_TIMEOUT_MS", 120_000);
  if (receiptPollMs > receiptTimeoutMs) {
    throw new RangeError("CLOCKIN_RECEIPT_POLL_MS must not exceed receipt timeout");
  }

  return Object.freeze({
    ...observation,
    wsRpcUrl,
    privateKey: privateKey as Hex,
    expectedWalletAddress,
    beneficiaryAddress:
      env.CLOCKIN_BENEFICIARY_ADDRESS?.trim() === undefined
        ? expectedWalletAddress
        : address(env, "CLOCKIN_BENEFICIARY_ADDRESS"),
    buyTo: address(env, "CLOCKIN_BUY_TO"),
    tokenAddress: address(env, "CLOCKIN_TOKEN_ADDRESS"),
    buyCallData: buyCallData as Hex,
    batchValueWei: positiveBigInt(env, "CLOCKIN_BATCH_VALUE_WEI"),
    gasLimit: positiveBigInt(env, "CLOCKIN_GAS_LIMIT"),
    maxFeePerGasWei,
    maxPriorityFeePerGasWei,
    broadcastRpcUrls: rpcUrls(env, observation.rpcUrl),
    receiptPollMs,
    receiptTimeoutMs,
    ledgerPath: env.CLOCKIN_LEDGER_PATH?.trim() || "runtime/clockin-live.ndjson",
    walletLeasePath: env.CLOCKIN_WALLET_LEASE_PATH?.trim() || "runtime/clockin-wallet.lock",
  });
}
