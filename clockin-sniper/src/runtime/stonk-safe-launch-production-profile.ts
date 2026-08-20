import { getAddress, isHexString } from "ethers";

import {
  CLOCKIN_APPROVED_LAUNCH_CREATOR,
  ROBINHOOD_WETH_ADDRESS,
  ROBINHOOD_WETH_RUNTIME_CODE_HASH,
  SAFE_LAUNCH_BUFFER_TAX_BPS,
  STONK_SAFE_LAUNCH_QUOTED_BUY_LIMIT_POLICY,
  STONK_SAFE_LAUNCH_QUOTED_ADAPTER_ID,
  STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
  STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
  STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
  STONK_SAFE_LAUNCH_WETH_FACTORY_RUNTIME_CODE_HASH,
} from "../adapters/stonk-safe-launch-quoted.js";
import { type Address, type Hex32, stableHash } from "../core/canonical.js";

/** Protocol-level bound for the dynamic launch field; execution has a separate owner cap. */
export const CLOCKIN_MAXIMUM_SUPPORTED_START_TAX_BPS = 10_000;
/** Owner-approved ceiling for the tax observed at the actual signing block. */
export const CLOCKIN_MAXIMUM_AUTHORIZED_ENTRY_TAX_BPS = 5_000;
/** First-buyable burst needs one legal state; it does not wait for a decay ladder. */
export const CLOCKIN_MINIMUM_DISTINCT_EXECUTABLE_TAX_STATES = 1;

export interface StonkSafeLaunchProductionProfile {
  readonly formatVersion: 2;
  readonly profileId: string;
  readonly revision: number;
  readonly chainId: 4663;
  readonly adapterId: typeof STONK_SAFE_LAUNCH_QUOTED_ADAPTER_ID;
  readonly factory: Readonly<{
    address: typeof STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS;
    runtimeCodeHash: typeof STONK_SAFE_LAUNCH_WETH_FACTORY_RUNTIME_CODE_HASH;
    startBlock: string;
    launchCreatedTopic: typeof STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC;
    launchArmedTopic: typeof STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC;
  }>;
  readonly quote: Readonly<{
    asset: typeof ROBINHOOD_WETH_ADDRESS;
    runtimeCodeHash: typeof ROBINHOOD_WETH_RUNTIME_CODE_HASH;
    fundingMode: "PREWRAPPED_WETH";
    allowanceMode: "PREAPPROVED_EXACT_PAD";
  }>;
  readonly identity: Readonly<{
    expectedCreator: typeof CLOCKIN_APPROVED_LAUNCH_CREATOR;
    identityAnchor: "EXACT_FACTORY_APPROVED_CREATOR_FIRST_PRIMARY_EVENT";
    displayNameHint: "CLOCK IN";
    symbolHint: "CLOCKIN";
    metadataAuthority: "AUDIT_ONLY";
    requirePrimaryExternalToken: false;
    officialCa: Readonly<{
      authority: "AUDIT_ONLY";
      url: string;
      jsonKey: string;
      pollMs: number;
    }>;
  }>;
  readonly mechanismBounds: Readonly<{
    bufferTaxBps: typeof SAFE_LAUNCH_BUFFER_TAX_BPS;
    maximumBufferSeconds: number;
    maximumStartTaxBps: number;
    maximumEntryTaxBps: typeof CLOCKIN_MAXIMUM_AUTHORIZED_ENTRY_TAX_BPS;
    minimumDecayPerMinuteBps: number;
    minimumWindowSeconds: number;
    maximumWindowSeconds: number;
    minimumDistinctExecutableTaxStates: 1;
    capMode: "NO_CAP";
    cooldownMode: "NONE";
    floorTaxBps: 0;
    eoaOnly: true;
  }>;
  readonly entry: Readonly<{
    refCode: Hex32;
    gasLimit: string;
    maximumFeePerGasWei: string;
    maximumPriorityFeePerGasWei: string;
    quoteMaximumAgeMs: number;
    maximumEntrySlippageBps: number;
    maximumExecutionDriftBps: number;
  }>;
  readonly expansion: Readonly<{
    executionMode: "FIRST_BUYABLE_ALL_TEN";
    requireCanonicalCanaryEffect: false;
    requireStrongOnchainBinding: true;
    requireExecutableExitBeforeLanes2To10: false;
  }>;
  readonly evidenceIds: readonly string[];
  readonly createdAt: string;
  readonly profileHash: string;
}

export type StonkSafeLaunchProductionProfileDraft = Omit<
  StonkSafeLaunchProductionProfile,
  "profileHash"
>;

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new RangeError(`${label} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

function decimal(value: unknown, label: string, allowZero = false): string {
  const parsed = text(value, label);
  if (!/^(0|[1-9][0-9]*)$/u.test(parsed) || (!allowZero && BigInt(parsed) === 0n)) {
    throw new TypeError(`${label} must be a canonical integer string`);
  }
  return parsed;
}

function exactAddress<T extends Address>(value: unknown, expected: T, label: string): T {
  const parsed = getAddress(text(value, label));
  if (parsed.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} does not match the verified mainnet value`);
  }
  return expected;
}

function exactHex32<T extends Hex32>(value: unknown, expected: T, label: string): T {
  const parsed = text(value, label);
  if (!isHexString(parsed, 32) || parsed.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} does not match the verified mainnet value`);
  }
  return expected;
}

function httpsUrl(value: unknown, label: string): string {
  const parsed = new URL(text(value, label));
  if (parsed.protocol !== "https:") throw new TypeError(`${label} must use HTTPS`);
  return parsed.toString();
}

function evidence(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new TypeError("evidenceIds must be a non-empty string array");
  }
  return Object.freeze([...value] as string[]);
}

export function freezeStonkSafeLaunchProductionProfile(
  draft: StonkSafeLaunchProductionProfileDraft,
): StonkSafeLaunchProductionProfile {
  return Object.freeze({ ...draft, profileHash: stableHash(draft) });
}

export function parseStonkSafeLaunchProductionProfile(
  value: unknown,
): StonkSafeLaunchProductionProfile {
  const input = object(value, "Safe Launch production profile");
  const factory = object(input.factory, "factory");
  const quote = object(input.quote, "quote");
  const identity = object(input.identity, "identity");
  const officialCa = object(identity.officialCa, "identity.officialCa");
  const bounds = object(input.mechanismBounds, "mechanismBounds");
  const entry = object(input.entry, "entry");
  const expansion = object(input.expansion, "expansion");
  if (input.formatVersion !== 2 || input.chainId !== 4_663) {
    throw new TypeError("Safe Launch profile must use format 2 and chainId 4663");
  }
  if (input.adapterId !== STONK_SAFE_LAUNCH_QUOTED_ADAPTER_ID) {
    throw new TypeError("Safe Launch production adapter is unsupported");
  }
  if (quote.fundingMode !== "PREWRAPPED_WETH" || quote.allowanceMode !== "PREAPPROVED_EXACT_PAD") {
    throw new TypeError("Safe Launch quote must be prewrapped and preapproved");
  }
  if (
    identity.identityAnchor !== "EXACT_FACTORY_APPROVED_CREATOR_FIRST_PRIMARY_EVENT" ||
    identity.displayNameHint !== "CLOCK IN" ||
    identity.symbolHint !== "CLOCKIN" ||
    identity.metadataAuthority !== "AUDIT_ONLY" ||
    identity.requirePrimaryExternalToken !== false ||
    officialCa.authority !== "AUDIT_ONLY"
  ) {
    throw new TypeError("Safe Launch identity policy differs from CLOCKIN primary launch");
  }
  if (
    bounds.bufferTaxBps !== SAFE_LAUNCH_BUFFER_TAX_BPS ||
    bounds.minimumDistinctExecutableTaxStates !== CLOCKIN_MINIMUM_DISTINCT_EXECUTABLE_TAX_STATES ||
    bounds.capMode !== STONK_SAFE_LAUNCH_QUOTED_BUY_LIMIT_POLICY.capScope ||
    bounds.cooldownMode !== STONK_SAFE_LAUNCH_QUOTED_BUY_LIMIT_POLICY.cooldownScope ||
    bounds.floorTaxBps !== 0 ||
    bounds.eoaOnly !== true
  ) {
    throw new TypeError("Safe Launch buffer/tax-state/limit/EOA invariants changed");
  }
  if (
    expansion.executionMode !== "FIRST_BUYABLE_ALL_TEN" ||
    expansion.requireCanonicalCanaryEffect !== false ||
    expansion.requireStrongOnchainBinding !== true ||
    expansion.requireExecutableExitBeforeLanes2To10 !== false
  ) {
    throw new TypeError("Safe Launch expansion policy changed");
  }
  const createdAt = new Date(text(input.createdAt, "createdAt")).toISOString();
  const draft: StonkSafeLaunchProductionProfileDraft = Object.freeze({
    formatVersion: 2,
    profileId: text(input.profileId, "profileId"),
    revision: integer(input.revision, "revision", 1),
    chainId: 4_663,
    adapterId: STONK_SAFE_LAUNCH_QUOTED_ADAPTER_ID,
    factory: Object.freeze({
      address: exactAddress(
        factory.address,
        STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
        "factory.address",
      ),
      runtimeCodeHash: exactHex32(
        factory.runtimeCodeHash,
        STONK_SAFE_LAUNCH_WETH_FACTORY_RUNTIME_CODE_HASH,
        "factory.runtimeCodeHash",
      ),
      startBlock: decimal(factory.startBlock, "factory.startBlock", true),
      launchCreatedTopic: exactHex32(
        factory.launchCreatedTopic,
        STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
        "factory.launchCreatedTopic",
      ),
      launchArmedTopic: exactHex32(
        factory.launchArmedTopic,
        STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
        "factory.launchArmedTopic",
      ),
    }),
    quote: Object.freeze({
      asset: exactAddress(quote.asset, ROBINHOOD_WETH_ADDRESS, "quote.asset"),
      runtimeCodeHash: exactHex32(
        quote.runtimeCodeHash,
        ROBINHOOD_WETH_RUNTIME_CODE_HASH,
        "quote.runtimeCodeHash",
      ),
      fundingMode: "PREWRAPPED_WETH",
      allowanceMode: "PREAPPROVED_EXACT_PAD",
    }),
    identity: Object.freeze({
      expectedCreator: exactAddress(
        identity.expectedCreator,
        CLOCKIN_APPROVED_LAUNCH_CREATOR,
        "identity.expectedCreator",
      ),
      identityAnchor: "EXACT_FACTORY_APPROVED_CREATOR_FIRST_PRIMARY_EVENT",
      displayNameHint: "CLOCK IN",
      symbolHint: "CLOCKIN",
      metadataAuthority: "AUDIT_ONLY",
      requirePrimaryExternalToken: false,
      officialCa: Object.freeze({
        authority: "AUDIT_ONLY",
        url: httpsUrl(officialCa.url, "identity.officialCa.url"),
        jsonKey: text(officialCa.jsonKey, "identity.officialCa.jsonKey"),
        pollMs: integer(officialCa.pollMs, "identity.officialCa.pollMs", 250),
      }),
    }),
    mechanismBounds: Object.freeze({
      bufferTaxBps: SAFE_LAUNCH_BUFFER_TAX_BPS,
      maximumBufferSeconds: integer(
        bounds.maximumBufferSeconds,
        "mechanismBounds.maximumBufferSeconds",
      ),
      maximumStartTaxBps: integer(bounds.maximumStartTaxBps, "mechanismBounds.maximumStartTaxBps"),
      maximumEntryTaxBps: integer(
        bounds.maximumEntryTaxBps,
        "mechanismBounds.maximumEntryTaxBps",
      ) as typeof CLOCKIN_MAXIMUM_AUTHORIZED_ENTRY_TAX_BPS,
      minimumDecayPerMinuteBps: integer(
        bounds.minimumDecayPerMinuteBps,
        "mechanismBounds.minimumDecayPerMinuteBps",
        1,
      ),
      minimumWindowSeconds: integer(
        bounds.minimumWindowSeconds,
        "mechanismBounds.minimumWindowSeconds",
        1,
      ),
      maximumWindowSeconds: integer(
        bounds.maximumWindowSeconds,
        "mechanismBounds.maximumWindowSeconds",
        1,
      ),
      minimumDistinctExecutableTaxStates: CLOCKIN_MINIMUM_DISTINCT_EXECUTABLE_TAX_STATES,
      capMode: STONK_SAFE_LAUNCH_QUOTED_BUY_LIMIT_POLICY.capScope,
      cooldownMode: STONK_SAFE_LAUNCH_QUOTED_BUY_LIMIT_POLICY.cooldownScope,
      floorTaxBps: 0,
      eoaOnly: true,
    }),
    entry: Object.freeze({
      refCode: exactHex32(entry.refCode, entry.refCode as Hex32, "entry.refCode"),
      gasLimit: decimal(entry.gasLimit, "entry.gasLimit"),
      maximumFeePerGasWei: decimal(entry.maximumFeePerGasWei, "entry.maximumFeePerGasWei"),
      maximumPriorityFeePerGasWei: decimal(
        entry.maximumPriorityFeePerGasWei,
        "entry.maximumPriorityFeePerGasWei",
        true,
      ),
      quoteMaximumAgeMs: integer(entry.quoteMaximumAgeMs, "entry.quoteMaximumAgeMs", 1),
      maximumEntrySlippageBps: integer(
        entry.maximumEntrySlippageBps,
        "entry.maximumEntrySlippageBps",
      ),
      maximumExecutionDriftBps: integer(
        entry.maximumExecutionDriftBps,
        "entry.maximumExecutionDriftBps",
      ),
    }),
    expansion: Object.freeze({
      executionMode: "FIRST_BUYABLE_ALL_TEN",
      requireCanonicalCanaryEffect: false,
      requireStrongOnchainBinding: true,
      requireExecutableExitBeforeLanes2To10: false,
    }),
    evidenceIds: evidence(input.evidenceIds),
    createdAt,
  });
  if (draft.mechanismBounds.maximumStartTaxBps > CLOCKIN_MAXIMUM_SUPPORTED_START_TAX_BPS) {
    throw new RangeError("maximum start tax exceeds the verified protocol field bound");
  }
  if (draft.mechanismBounds.maximumEntryTaxBps !== CLOCKIN_MAXIMUM_AUTHORIZED_ENTRY_TAX_BPS) {
    throw new RangeError("maximum entry tax differs from the owner-approved execution bound");
  }
  if (draft.mechanismBounds.minimumWindowSeconds > draft.mechanismBounds.maximumWindowSeconds) {
    throw new RangeError("Safe Launch window bounds are inverted");
  }
  if (BigInt(draft.entry.maximumPriorityFeePerGasWei) > BigInt(draft.entry.maximumFeePerGasWei)) {
    throw new RangeError("entry priority fee exceeds maximum fee");
  }
  for (const bps of [draft.entry.maximumEntrySlippageBps, draft.entry.maximumExecutionDriftBps]) {
    if (bps < 0 || bps >= 10_000) throw new RangeError("entry drift bps must be in 0..9999");
  }
  const expectedHash = stableHash(draft);
  if (text(input.profileHash, "profileHash") !== expectedHash) {
    throw new Error("Safe Launch production profile hash mismatch");
  }
  return Object.freeze({ ...draft, profileHash: expectedHash });
}

export function assertLaunchWithinProductionBounds(
  profile: StonkSafeLaunchProductionProfile,
  launch: Readonly<{
    startTaxBps: number;
    decayPerMinuteBps: number;
    windowSeconds: number;
    bufferSeconds: number;
    externalToken: boolean;
  }>,
): void {
  if (launch.externalToken !== profile.identity.requirePrimaryExternalToken) {
    throw new Error("primary WETH launch external-token flag is inconsistent");
  }
  if (
    launch.startTaxBps <= 0 ||
    launch.startTaxBps > profile.mechanismBounds.maximumStartTaxBps ||
    launch.decayPerMinuteBps < profile.mechanismBounds.minimumDecayPerMinuteBps ||
    launch.bufferSeconds > profile.mechanismBounds.maximumBufferSeconds ||
    launch.windowSeconds < profile.mechanismBounds.minimumWindowSeconds ||
    launch.windowSeconds > profile.mechanismBounds.maximumWindowSeconds
  ) {
    throw new Error("dynamic launch economics exceed the authorized production bounds");
  }
  const maximumExecutableMinute = Math.floor((launch.windowSeconds - 1) / 60);
  const distinctExecutableTaxStates = new Set<number>();
  for (let minute = 0; minute <= maximumExecutableMinute; minute += 1) {
    distinctExecutableTaxStates.add(
      Math.max(0, launch.startTaxBps - minute * launch.decayPerMinuteBps),
    );
  }
  if (
    distinctExecutableTaxStates.size < profile.mechanismBounds.minimumDistinctExecutableTaxStates
  ) {
    throw new Error("dynamic launch economics provide no executable tax state");
  }
  const hasAuthorizedEntryState = [...distinctExecutableTaxStates].some(
    (taxBps) =>
      taxBps <= profile.mechanismBounds.maximumEntryTaxBps &&
      taxBps !== profile.mechanismBounds.bufferTaxBps,
  );
  if (!hasAuthorizedEntryState) {
    throw new Error("dynamic launch economics never reach the owner-authorized entry tax");
  }
}
