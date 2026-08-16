import { USD_MICROS_PER_USD } from "./domain.js";
import type { LaunchIdentityPolicy } from "./stonk-launcher.js";
import { assertAddress, assertHex } from "./rpc/hex.js";
import { ROBINHOOD_MAINNET_SEQUENCER_URL } from "./rpc/robinhood.js";
import type { Hex } from "./rpc/types.js";
import type { RuntimeEnvironment } from "./runtime-config.js";

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

function nonNegativeInteger(env: RuntimeEnvironment, name: string, defaultValue: number): number {
  const raw = env[name]?.trim();
  const value = raw === undefined || raw.length === 0 ? defaultValue : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
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

function nonNegativeBigInt(env: RuntimeEnvironment, name: string, defaultValue: bigint): bigint {
  const raw = env[name]?.trim();
  let value: bigint;
  try {
    value = raw === undefined || raw.length === 0 ? defaultValue : BigInt(raw);
  } catch {
    throw new TypeError(`${name} must be an integer string`);
  }
  if (value < 0n) throw new RangeError(`${name} must not be negative`);
  return value;
}

function optionalAddress(env: RuntimeEnvironment, name: string): Hex | undefined {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) return undefined;
  assertAddress(name, value);
  return value;
}

function address(env: RuntimeEnvironment, name: string): Hex {
  const value = required(env, name);
  assertAddress(name, value);
  return value;
}

function optionalBlock(env: RuntimeEnvironment): bigint | undefined {
  const raw = env.CLOCKIN_DISCOVERY_START_BLOCK?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  const value = BigInt(raw);
  if (value < 0n) throw new RangeError("CLOCKIN_DISCOVERY_START_BLOCK must not be negative");
  return value;
}

function rpcUrls(env: RuntimeEnvironment, canonicalUrl: string): readonly string[] {
  const configured =
    env.ROBINHOOD_BROADCAST_RPC_URLS?.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0) ?? [];
  const unique = [...new Set([canonicalUrl, ...configured])];
  for (const value of unique) {
    const parsed = new URL(value);
    const protocol = parsed.protocol;
    if (protocol !== "http:" && protocol !== "https:") {
      throw new RangeError("ROBINHOOD_BROADCAST_RPC_URLS must contain HTTP(S) URLs");
    }
    if (parsed.hostname === "sequencer.mainnet.chain.robinhood.com") {
      throw new RangeError(
        "configure the official write-only endpoint with ROBINHOOD_DIRECT_SEQUENCER_URL",
      );
    }
  }
  return Object.freeze(unique);
}

function directSequencerUrl(env: RuntimeEnvironment): string | undefined {
  const configured = env.ROBINHOOD_DIRECT_SEQUENCER_URL;
  const value =
    configured === undefined ? ROBINHOOD_MAINNET_SEQUENCER_URL : configured.trim() || undefined;
  if (value === undefined) return undefined;
  const parsed = new URL(value);
  if (parsed.href !== new URL(ROBINHOOD_MAINNET_SEQUENCER_URL).href) {
    throw new RangeError(
      "ROBINHOOD_DIRECT_SEQUENCER_URL must be the official Robinhood mainnet HTTPS endpoint",
    );
  }
  return value;
}

export interface FactoryLiveRuntimeConfig {
  readonly rpcUrl: string;
  readonly wsRpcUrl: string;
  readonly providerId: string;
  readonly broadcastRpcUrls: readonly string[];
  readonly directSequencerUrl?: string;
  readonly privateKey: Hex;
  readonly expectedWalletAddress: Hex;
  readonly launchId: string;
  readonly identityPolicy: LaunchIdentityPolicy;
  readonly expectedFactoryCodeHash: Hex;
  readonly discoveryStartBlock?: bigint;
  readonly batchCount: 10;
  readonly grossUsdMicrosPerBatch: bigint;
  readonly batchValueWei: bigint;
  readonly feeWindowDurationMs: number;
  readonly expectedFloorFeeBps: number;
  readonly maxInitialFeeBps: number;
  readonly chainAuthorizedTrancheCount: 1;
  readonly minTokensOut: bigint;
  readonly refCode: Hex;
  readonly gasLimit: bigint;
  readonly maxFeePerGasWei: bigint;
  readonly maxPriorityFeePerGasWei: bigint;
  readonly officialCaInitial?: Hex;
  readonly officialCaFilePath: string;
  readonly officialCaUrl: string | undefined;
  readonly officialCaJsonKey: string;
  readonly officialCaPollMs: number;
  readonly receiptPollMs: number;
  readonly receiptTimeoutMs: number;
  readonly ledgerPath: string;
  readonly walletLeasePath: string;
}

/** Factory-first live configuration. No target CA, pool, or calldata is accepted up front. */
export function loadFactoryLiveRuntimeConfig(env: RuntimeEnvironment): FactoryLiveRuntimeConfig {
  if (env.CLOCKIN_LIVE?.trim() !== "true") {
    throw new Error("CLOCKIN_LIVE=true is required for the real-funds executor");
  }
  const rpcUrl = required(env, "ROBINHOOD_RPC_URL");
  const wsRpcUrl = required(env, "ROBINHOOD_WS_RPC_URL");
  if (!/^https?:/.test(new URL(rpcUrl).protocol)) {
    throw new RangeError("ROBINHOOD_RPC_URL must use HTTP(S)");
  }
  if (!/^wss?:/.test(new URL(wsRpcUrl).protocol)) {
    throw new RangeError("ROBINHOOD_WS_RPC_URL must use WS(S)");
  }

  const privateKey = required(env, "CLOCKIN_PRIVATE_KEY");
  assertHex("CLOCKIN_PRIVATE_KEY", privateKey);
  if (privateKey.length !== 66) {
    throw new RangeError("CLOCKIN_PRIVATE_KEY must be exactly 32 bytes");
  }
  const expectedFactoryCodeHash = required(env, "CLOCKIN_FACTORY_RUNTIME_CODE_HASH");
  assertHex("CLOCKIN_FACTORY_RUNTIME_CODE_HASH", expectedFactoryCodeHash);
  if (expectedFactoryCodeHash.length !== 66) {
    throw new RangeError("CLOCKIN_FACTORY_RUNTIME_CODE_HASH must be 32 bytes");
  }
  const refCode = env.CLOCKIN_REF_CODE?.trim() || `0x${"00".repeat(32)}`;
  assertHex("CLOCKIN_REF_CODE", refCode);
  if (refCode.length !== 66) throw new RangeError("CLOCKIN_REF_CODE must be bytes32");

  const maxFeePerGasWei = positiveBigInt(env, "CLOCKIN_MAX_FEE_PER_GAS_WEI");
  const maxPriorityFeePerGasWei = nonNegativeBigInt(
    env,
    "CLOCKIN_MAX_PRIORITY_FEE_PER_GAS_WEI",
    0n,
  );
  if (maxPriorityFeePerGasWei > maxFeePerGasWei) {
    throw new RangeError("CLOCKIN_MAX_PRIORITY_FEE_PER_GAS_WEI exceeds max fee");
  }

  const expectedName = env.CLOCKIN_EXPECTED_NAME?.trim() || "ClockIn";
  const expectedSymbol = env.CLOCKIN_EXPECTED_SYMBOL?.trim() || "CLOCKIN";
  const metadataIncludes = env.CLOCKIN_EXPECTED_METADATA_SUBSTRING?.trim() || undefined;
  const expectedCreator = optionalAddress(env, "CLOCKIN_EXPECTED_CREATOR");
  const suffixRaw = env.CLOCKIN_REQUIRED_TOKEN_SUFFIX;
  const requiredTokenSuffix = suffixRaw === undefined ? "666666" : suffixRaw.trim() || undefined;
  const officialCaUrlRaw = env.CLOCKIN_OFFICIAL_CA_URL;
  const officialCaUrl =
    officialCaUrlRaw === undefined ? "https://clockin.win/" : officialCaUrlRaw.trim() || undefined;
  if (officialCaUrl !== undefined) new URL(officialCaUrl);
  const discoveryStartBlock = optionalBlock(env);
  const officialCaInitial = optionalAddress(env, "CLOCKIN_OFFICIAL_CA");
  const sequencerUrl = directSequencerUrl(env);

  const receiptPollMs = positiveInteger(env, "CLOCKIN_RECEIPT_POLL_MS", 250);
  const receiptTimeoutMs = positiveInteger(env, "CLOCKIN_RECEIPT_TIMEOUT_MS", 240_000);
  if (receiptPollMs > receiptTimeoutMs) {
    throw new RangeError("CLOCKIN_RECEIPT_POLL_MS must not exceed receipt timeout");
  }
  if (
    nonNegativeInteger(env, "CLOCKIN_BATCH_COUNT", 10) !== 10 ||
    nonNegativeInteger(env, "CLOCKIN_BATCH_USD", 5) !== 5 ||
    nonNegativeInteger(env, "CLOCKIN_CHAIN_AUTHORIZED_TRANCHES", 1) !== 1
  ) {
    throw new Error(
      "Factory live strategy is fixed at 10 x 5U with only tranche one chain-authorized",
    );
  }

  return Object.freeze({
    rpcUrl,
    wsRpcUrl,
    providerId: env.ROBINHOOD_RPC_PROVIDER_ID?.trim() || "clockin-factory-live",
    broadcastRpcUrls: rpcUrls(env, rpcUrl),
    ...(sequencerUrl === undefined ? {} : { directSequencerUrl: sequencerUrl }),
    privateKey: privateKey as Hex,
    expectedWalletAddress: address(env, "CLOCKIN_EXPECTED_WALLET_ADDRESS"),
    launchId: required(env, "CLOCKIN_LAUNCH_ID"),
    identityPolicy: Object.freeze({
      factoryAddress: address(env, "CLOCKIN_FACTORY_ADDRESS"),
      expectedName,
      expectedSymbol,
      ...(expectedCreator === undefined ? {} : { expectedCreator }),
      ...(metadataIncludes === undefined ? {} : { metadataIncludes }),
      ...(requiredTokenSuffix === undefined ? {} : { requiredTokenSuffix }),
    }),
    expectedFactoryCodeHash: expectedFactoryCodeHash as Hex,
    ...(discoveryStartBlock === undefined ? {} : { discoveryStartBlock }),
    batchCount: 10,
    grossUsdMicrosPerBatch: 5n * USD_MICROS_PER_USD,
    batchValueWei: positiveBigInt(env, "CLOCKIN_BATCH_VALUE_WEI"),
    feeWindowDurationMs: positiveInteger(env, "CLOCKIN_FEE_WINDOW_MS", 120_000),
    expectedFloorFeeBps: nonNegativeInteger(env, "CLOCKIN_FLOOR_FEE_BPS", 100),
    maxInitialFeeBps: positiveInteger(env, "CLOCKIN_MAX_INITIAL_FEE_BPS", 4_000),
    chainAuthorizedTrancheCount: 1,
    minTokensOut: nonNegativeBigInt(env, "CLOCKIN_MIN_TOKENS_OUT_RAW", 1n),
    refCode: refCode as Hex,
    gasLimit: positiveBigInt(env, "CLOCKIN_GAS_LIMIT"),
    maxFeePerGasWei,
    maxPriorityFeePerGasWei,
    ...(officialCaInitial === undefined ? {} : { officialCaInitial }),
    officialCaFilePath: env.CLOCKIN_OFFICIAL_CA_FILE?.trim() || "runtime/official-clockin-ca.txt",
    officialCaUrl,
    officialCaJsonKey: env.CLOCKIN_OFFICIAL_CA_JSON_KEY?.trim() || "contractAddress",
    officialCaPollMs: positiveInteger(env, "CLOCKIN_OFFICIAL_CA_POLL_MS", 500),
    receiptPollMs,
    receiptTimeoutMs,
    ledgerPath: env.CLOCKIN_LEDGER_PATH?.trim() || "runtime/clockin-live.ndjson",
    walletLeasePath: env.CLOCKIN_WALLET_LEASE_PATH?.trim() || "runtime/clockin-wallet.lock",
  });
}
