import { USD_MICROS_PER_USD, type ClockInPlanConfig } from "./domain.js";
import type { ExternalBuyRule, PoolObserverConfig } from "./pool-observer.js";
import { assertAddress, assertHex } from "./rpc/hex.js";
import { ROBINHOOD_PUBLIC_RPC_URL } from "./rpc/robinhood.js";
import type { Hex } from "./rpc/types.js";

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function required(env: RuntimeEnvironment, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function integer(env: RuntimeEnvironment, name: string, defaultValue?: number): number {
  const raw = env[name]?.trim();
  if ((raw === undefined || raw.length === 0) && defaultValue !== undefined) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer`);
  }
  return value;
}

function unsignedBigInt(env: RuntimeEnvironment, name: string): bigint {
  const value = BigInt(required(env, name));
  if (value < 0n) throw new RangeError(`${name} must not be negative`);
  return value;
}

function loadExternalBuyRule(env: RuntimeEnvironment): ExternalBuyRule {
  const booleanCallData = env.CLOCKIN_BUY_ALLOWED_CALL_DATA?.trim();
  const launchBlock = env.CLOCKIN_LAUNCH_BLOCK?.trim();
  const firstExternalBlock = env.CLOCKIN_FIRST_EXTERNAL_BUY_BLOCK?.trim();
  const always = env.CLOCKIN_EXTERNAL_BUY_ALWAYS === "true";
  const configuredCount = [
    booleanCallData !== undefined && booleanCallData.length > 0,
    launchBlock !== undefined && launchBlock.length > 0,
    firstExternalBlock !== undefined && firstExternalBlock.length > 0,
    always,
  ].filter(Boolean).length;
  if (configuredCount !== 1) {
    throw new Error(
      "set exactly one of CLOCKIN_BUY_ALLOWED_CALL_DATA, CLOCKIN_LAUNCH_BLOCK, " +
        "CLOCKIN_FIRST_EXTERNAL_BUY_BLOCK, or CLOCKIN_EXTERNAL_BUY_ALWAYS=true",
    );
  }

  if (booleanCallData !== undefined && booleanCallData.length > 0) {
    assertHex("CLOCKIN_BUY_ALLOWED_CALL_DATA", booleanCallData);
    return Object.freeze({ kind: "boolean_call", callData: booleanCallData });
  }

  if (launchBlock !== undefined && launchBlock.length > 0) {
    return Object.freeze({
      kind: "block_after",
      launchBlock: unsignedBigInt(env, "CLOCKIN_LAUNCH_BLOCK"),
    });
  }

  if (firstExternalBlock !== undefined && firstExternalBlock.length > 0) {
    return Object.freeze({
      kind: "block_at_or_after",
      firstExternalBuyBlock: unsignedBigInt(env, "CLOCKIN_FIRST_EXTERNAL_BUY_BLOCK"),
    });
  }

  if (always) {
    return Object.freeze({ kind: "always" });
  }

  throw new Error(
    "set exactly one of CLOCKIN_BUY_ALLOWED_CALL_DATA, CLOCKIN_LAUNCH_BLOCK, " +
      "CLOCKIN_FIRST_EXTERNAL_BUY_BLOCK, or CLOCKIN_EXTERNAL_BUY_ALWAYS=true",
  );
}

export interface ObservationRuntimeConfig {
  readonly rpcUrl: string;
  readonly wsRpcUrl: string | null;
  readonly providerId: string;
  readonly pollIntervalMs: number;
  readonly pool: PoolObserverConfig;
  readonly plan: ClockInPlanConfig;
}

export function loadObservationRuntimeConfig(env: RuntimeEnvironment): ObservationRuntimeConfig {
  const poolAddress = required(env, "CLOCKIN_POOL_ADDRESS");
  const feeCallData = required(env, "CLOCKIN_FEE_CALL_DATA");
  assertAddress("CLOCKIN_POOL_ADDRESS", poolAddress);
  assertHex("CLOCKIN_FEE_CALL_DATA", feeCallData);

  const startFeeBps = integer(env, "CLOCKIN_START_FEE_BPS", 4_000);
  const floorFeeBps = integer(env, "CLOCKIN_FLOOR_FEE_BPS", 100);
  const batchCount = integer(env, "CLOCKIN_BATCH_COUNT", 10);
  const grossUsdMicrosPerBatch = BigInt(integer(env, "CLOCKIN_BATCH_USD", 5)) * USD_MICROS_PER_USD;

  return Object.freeze({
    rpcUrl: env.ROBINHOOD_RPC_URL?.trim() || ROBINHOOD_PUBLIC_RPC_URL,
    wsRpcUrl: env.ROBINHOOD_WS_RPC_URL?.trim() || null,
    providerId: env.ROBINHOOD_RPC_PROVIDER_ID?.trim() || "robinhood-live",
    pollIntervalMs: integer(env, "CLOCKIN_POLL_INTERVAL_MS", 250),
    pool: Object.freeze({
      poolAddress: poolAddress as Hex,
      feeCallData: feeCallData as Hex,
      externalBuyRule: loadExternalBuyRule(env),
    }),
    plan: Object.freeze({
      launchId: required(env, "CLOCKIN_LAUNCH_ID"),
      windowStartedAtMs: integer(env, "CLOCKIN_WINDOW_STARTED_AT_MS"),
      windowDurationMs: integer(env, "CLOCKIN_WINDOW_DURATION_MS", 120_000),
      startFeeBps,
      floorFeeBps,
      batchCount,
      grossUsdMicrosPerBatch,
    }),
  });
}
