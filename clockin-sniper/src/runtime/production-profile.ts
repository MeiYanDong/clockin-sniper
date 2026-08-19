import {
  EventFragment,
  FunctionFragment,
  getAddress,
  Interface,
  isHexString,
  ZeroAddress,
} from "ethers";

import { CLOCKIN_POLICY_V2 } from "../config/strategy-config.js";
import { type Address, type Hex32, stableHash } from "../core/canonical.js";
import { BOUNDED_CANARY_POLICY_HASH } from "../entry/bounded-canary-policy.js";
import type { CapScope, CooldownScope } from "../identity/mechanism-profiler.js";
import type { WalletManifest } from "../wallets/wallet-manifest.js";

export const SUPPORTED_PRODUCTION_ADAPTER = "clockin.configured-launcher-native-v1" as const;

export interface ProductionFunctionAbi {
  readonly currentFee: string;
  readonly inWindow: string;
  readonly currentCap: string;
  readonly buyCooldown: string;
  readonly eoaOnly: string;
  readonly quoteAsset: string;
  readonly previewBuy: string;
  readonly buy: string;
}

export interface ProductionExitRoute {
  readonly routeId: string;
  readonly routeKind: "LAUNCH_POOL" | "EXTERNAL_AMM";
  readonly adapterId: string;
  /** FIXED binds a reviewed router; LAUNCH_POOL resolves only from the frozen Factory event. */
  readonly targetMode: "FIXED" | "LAUNCH_POOL";
  readonly target?: Address;
  readonly runtimeCodeHash: Hex32;
  readonly quoteAsset: Address;
  readonly allowanceMode: "NONE" | "APPROVE" | "PERMIT";
  readonly approvalSpenderMode: "NONE" | "FIXED" | "ROUTE_TARGET";
  readonly approvalSpender?: Address;
  readonly quoteCallLayout: "TOKEN_IN" | "TOKEN_IN_PATH";
  /** The bound quote already includes protocol fee, tax and price impact, but not wallet gas. */
  readonly quoteOutputKind: "EXECUTABLE_BEFORE_GAS";
  readonly sellCallLayout:
    | "TOKEN_IN_MIN_OUT_RECIPIENT"
    | "TOKEN_IN_MIN_OUT_PATH_RECIPIENT_DEADLINE";
  /** TOKEN_PREFIX prepends the frozen launch token to the configured tail at runtime. */
  readonly pathMode: "NONE" | "STATIC" | "TOKEN_PREFIX";
  readonly path: readonly Address[];
  readonly quoteFunctionAbi: string;
  readonly sellFunctionAbi: string;
  readonly approvalGasLimit: string;
  readonly sellGasLimit: string;
  readonly maximumFeePerGasWei: string;
  readonly maximumPriorityFeePerGasWei: string;
  readonly quoteMaximumAgeMs: number;
  readonly evidenceIds: readonly string[];
}

export interface ProductionProtocolProfile {
  readonly formatVersion: 1;
  readonly profileId: string;
  readonly revision: number;
  readonly chainId: 4663;
  readonly adapterId: typeof SUPPORTED_PRODUCTION_ADAPTER;
  readonly factory: Readonly<{
    address: Address;
    runtimeCodeHash: Hex32;
    implementationAddress?: Address;
    implementationCodeHash?: Hex32;
    startBlock: string;
    launchEventAbi: string;
    launchEventTopic: Hex32;
    launchFields: Readonly<{
      creator: string;
      token: string;
      pool: string;
      name: string;
      symbol: string;
      metadataUri: string;
      imageHash: string;
    }>;
  }>;
  readonly identity: Readonly<{
    expectedName: string;
    expectedSymbol: string;
    expectedCreator?: Address;
    metadataIncludes?: string;
    requiredTokenSuffix?: string;
    officialCa: Readonly<{
      url: string;
      jsonKey: string;
      pollMs: number;
    }>;
  }>;
  readonly mechanism: Readonly<{
    profileId: string;
    revision: number;
    kind: "CLOCKIN_40PCT_2MIN_V1";
    maximumInitialFeeBps: number;
    floorFeeBps: number;
    decayWindowSeconds: number;
    decayModel: "LINEAR_TIME";
    capScope: Exclude<CapScope, "UNKNOWN">;
    cooldownScope: Exclude<CooldownScope, "UNKNOWN">;
    quoteAsset: Address;
    poolRuntimeCodeHashes: readonly Hex32[];
    tokenRuntimeCodeHashes: readonly Hex32[];
    functions: ProductionFunctionAbi;
  }>;
  readonly entry: Readonly<{
    refCode: Hex32;
    gasLimit: string;
    maximumFeePerGasWei: string;
    maximumPriorityFeePerGasWei: string;
    quoteMaximumAgeMs: number;
    laterLaneMaximumDriftBps: number;
    canaryMinimumOutputRaw: string;
    maximumExecutionDriftBps: number;
  }>;
  readonly exit: Readonly<{
    routes: readonly ProductionExitRoute[];
  }>;
  readonly evidenceIds: readonly string[];
  readonly createdAt: string;
  readonly profileHash: string;
}

export interface ProductionAuthorization {
  readonly formatVersion: 1;
  readonly authorizationId: string;
  readonly mode: "AUTO_POLICY";
  readonly actorRef: string;
  readonly policyId: "clockin-policy-v2";
  readonly policyVersion: "2";
  readonly profileId: string;
  readonly profileRevision: number;
  readonly profileHash: string;
  readonly strategyConfigHash: string;
  readonly walletManifestHash: string;
  readonly scopeHash: string;
  readonly riskEnvelopeHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly evidenceIds: readonly string[];
  readonly reason: string;
}

/** Minimal immutable profile identity used by the shared seven-day authorization envelope. */
export interface ProductionAuthorizationProfileRef {
  readonly profileId: string;
  readonly revision: number;
  readonly profileHash: string;
}

export type ProductionProfileDraft = Omit<ProductionProtocolProfile, "profileHash">;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
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
  const text = stringValue(value, label);
  if (!/^(0|[1-9][0-9]*)$/.test(text) || (!allowZero && BigInt(text) === 0n)) {
    throw new TypeError(
      `${label} must be a canonical ${allowZero ? "non-negative" : "positive"} integer string`,
    );
  }
  return text;
}

function address(value: unknown, label: string): Address {
  return getAddress(stringValue(value, label)) as Address;
}

function hex32(value: unknown, label: string): Hex32 {
  const text = stringValue(value, label);
  if (!isHexString(text, 32)) throw new TypeError(`${label} must be a 32-byte hex value`);
  return text.toLowerCase() as Hex32;
}

function iso(value: unknown, label: string): string {
  const text = stringValue(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${label} must be ISO-8601`);
  return new Date(text).toISOString();
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new TypeError(`${label} must be a non-empty-string array`);
  }
  return Object.freeze([...value] as string[]);
}

function addressArray(value: unknown, label: string): readonly Hex32[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must contain at least one code hash`);
  }
  return Object.freeze(value.map((item, index) => hex32(item, `${label}[${index}]`)));
}

function routePath(value: unknown, label: string): readonly Address[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an address array`);
  return Object.freeze(value.map((item, index) => address(item, `${label}[${index}]`)));
}

function optionalAddress(value: unknown, label: string): Address | undefined {
  return value === undefined ? undefined : address(value, label);
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, label);
}

function httpsUrl(value: unknown, label: string): string {
  const text = stringValue(value, label);
  const parsed = new URL(text);
  if (parsed.protocol !== "https:") throw new TypeError(`${label} must use HTTPS`);
  return parsed.toString();
}

function validateFunctionAbi(value: unknown, label: string, expectedName: string): string {
  const abi = stringValue(value, label);
  let fragment: FunctionFragment | null;
  try {
    const parsed = new Interface([abi]);
    fragment = parsed.getFunction(expectedName);
  } catch (error) {
    throw new TypeError(`${label} is not a valid ${expectedName} function ABI`, { cause: error });
  }
  if (fragment === null || fragment.name !== expectedName) {
    throw new TypeError(`${label} must define ${expectedName}`);
  }
  return abi;
}

function validateFunctionShape(input: {
  value: unknown;
  label: string;
  name: string;
  inputs: readonly string[];
  outputs: readonly string[];
  mutability: readonly ("pure" | "view" | "nonpayable" | "payable")[];
}): string {
  const abi = validateFunctionAbi(input.value, input.label, input.name);
  const fragment = FunctionFragment.from(abi);
  const actualInputs = fragment.inputs.map((parameter) => parameter.type);
  const actualOutputs = fragment.outputs?.map((parameter) => parameter.type) ?? [];
  if (
    actualInputs.length !== input.inputs.length ||
    actualInputs.some((type, index) => type !== input.inputs[index]) ||
    actualOutputs.length !== input.outputs.length ||
    actualOutputs.some((type, index) => type !== input.outputs[index]) ||
    !input.mutability.includes(fragment.stateMutability)
  ) {
    throw new TypeError(`${input.label} does not match the configured adapter function shape`);
  }
  return abi;
}

function parseLaunchFields(value: unknown): ProductionProtocolProfile["factory"]["launchFields"] {
  const input = record(value, "factory.launchFields");
  const fields = Object.freeze({
    creator: stringValue(input.creator, "factory.launchFields.creator"),
    token: stringValue(input.token, "factory.launchFields.token"),
    pool: stringValue(input.pool, "factory.launchFields.pool"),
    name: stringValue(input.name, "factory.launchFields.name"),
    symbol: stringValue(input.symbol, "factory.launchFields.symbol"),
    metadataUri: stringValue(input.metadataUri, "factory.launchFields.metadataUri"),
    imageHash: stringValue(input.imageHash, "factory.launchFields.imageHash"),
  });
  if (new Set(Object.values(fields)).size !== Object.keys(fields).length) {
    throw new TypeError("factory launch field mappings must be unique");
  }
  return fields;
}

function validateEventAbi(
  value: unknown,
  expectedTopic: Hex32,
  fields: ProductionProtocolProfile["factory"]["launchFields"],
): string {
  const abi = stringValue(value, "factory.launchEventAbi");
  let event: EventFragment;
  try {
    event = EventFragment.from(abi);
    new Interface([event]);
  } catch (error) {
    throw new TypeError("factory.launchEventAbi is invalid", { cause: error });
  }
  if (event.topicHash.toLowerCase() !== expectedTopic.toLowerCase()) {
    throw new TypeError("factory launch event ABI does not match launchEventTopic");
  }
  const names = new Set(event.inputs.map((input) => input.name));
  for (const field of Object.values(fields)) {
    if (!names.has(field))
      throw new TypeError(`factory launch event is missing named field ${field}`);
  }
  const expectedTypes = new Map<string, string>([
    [fields.creator, "address"],
    [fields.token, "address"],
    [fields.pool, "address"],
    [fields.name, "string"],
    [fields.symbol, "string"],
    [fields.metadataUri, "string"],
    [fields.imageHash, "bytes32"],
  ]);
  for (const [field, expectedType] of expectedTypes) {
    const parameter = event.inputs.find((input) => input.name === field);
    if (parameter?.type !== expectedType) {
      throw new TypeError(`factory launch event field ${field} must be ${expectedType}`);
    }
  }
  return abi;
}

function parseFunctions(value: unknown): ProductionFunctionAbi {
  const input = record(value, "mechanism.functions");
  return Object.freeze({
    currentFee: validateFunctionShape({
      value: input.currentFee,
      label: "functions.currentFee",
      name: "currentFeeBps",
      inputs: [],
      outputs: ["uint256"],
      mutability: ["view", "pure"],
    }),
    inWindow: validateFunctionShape({
      value: input.inWindow,
      label: "functions.inWindow",
      name: "inSniperWindow",
      inputs: [],
      outputs: ["bool"],
      mutability: ["view", "pure"],
    }),
    currentCap: validateFunctionShape({
      value: input.currentCap,
      label: "functions.currentCap",
      name: "currentWindowCap",
      inputs: [],
      outputs: ["uint256"],
      mutability: ["view", "pure"],
    }),
    buyCooldown: validateFunctionShape({
      value: input.buyCooldown,
      label: "functions.buyCooldown",
      name: "buyCooldownSecs",
      inputs: [],
      outputs: ["uint256"],
      mutability: ["view", "pure"],
    }),
    eoaOnly: validateFunctionShape({
      value: input.eoaOnly,
      label: "functions.eoaOnly",
      name: "eoaOnlySecs",
      inputs: [],
      outputs: ["uint256"],
      mutability: ["view", "pure"],
    }),
    quoteAsset: validateFunctionShape({
      value: input.quoteAsset,
      label: "functions.quoteAsset",
      name: "quoteAsset",
      inputs: [],
      outputs: ["address"],
      mutability: ["view", "pure"],
    }),
    previewBuy: validateFunctionShape({
      value: input.previewBuy,
      label: "functions.previewBuy",
      name: "previewBuy",
      inputs: ["uint256"],
      outputs: ["uint256"],
      mutability: ["view", "pure"],
    }),
    buy: validateFunctionShape({
      value: input.buy,
      label: "functions.buy",
      name: "buy",
      inputs: ["uint256", "bytes32"],
      outputs: ["uint256"],
      mutability: ["payable"],
    }),
  });
}

function parseRoute(value: unknown, index: number): ProductionExitRoute {
  const input = record(value, `exit.routes[${index}]`);
  const routeKind = stringValue(input.routeKind, `exit.routes[${index}].routeKind`);
  if (routeKind !== "LAUNCH_POOL" && routeKind !== "EXTERNAL_AMM") {
    throw new TypeError(`exit.routes[${index}].routeKind is unsupported`);
  }
  const targetMode = stringValue(input.targetMode, `exit.routes[${index}].targetMode`);
  if (targetMode !== "FIXED" && targetMode !== "LAUNCH_POOL") {
    throw new TypeError(`exit.routes[${index}].targetMode is unsupported`);
  }
  const target = optionalAddress(input.target, `exit.routes[${index}].target`);
  if (targetMode === "FIXED" && target === undefined) {
    throw new TypeError(`exit.routes[${index}].target is required for FIXED targetMode`);
  }
  if (targetMode === "LAUNCH_POOL" && target !== undefined) {
    throw new TypeError(`exit.routes[${index}].target must be omitted for LAUNCH_POOL targetMode`);
  }
  if (targetMode === "LAUNCH_POOL" && routeKind !== "LAUNCH_POOL") {
    throw new TypeError(`exit.routes[${index}] dynamic target must be a LAUNCH_POOL route`);
  }
  const allowanceMode = stringValue(input.allowanceMode, `exit.routes[${index}].allowanceMode`);
  if (allowanceMode !== "NONE" && allowanceMode !== "APPROVE" && allowanceMode !== "PERMIT") {
    throw new TypeError(`exit.routes[${index}].allowanceMode is unsupported`);
  }
  const quoteCallLayout = stringValue(
    input.quoteCallLayout,
    `exit.routes[${index}].quoteCallLayout`,
  );
  if (quoteCallLayout !== "TOKEN_IN" && quoteCallLayout !== "TOKEN_IN_PATH") {
    throw new TypeError(`exit.routes[${index}].quoteCallLayout is unsupported`);
  }
  if (input.quoteOutputKind !== "EXECUTABLE_BEFORE_GAS") {
    throw new TypeError(`exit.routes[${index}].quoteOutputKind must be EXECUTABLE_BEFORE_GAS`);
  }
  const sellCallLayout = stringValue(input.sellCallLayout, `exit.routes[${index}].sellCallLayout`);
  if (
    sellCallLayout !== "TOKEN_IN_MIN_OUT_RECIPIENT" &&
    sellCallLayout !== "TOKEN_IN_MIN_OUT_PATH_RECIPIENT_DEADLINE"
  ) {
    throw new TypeError(`exit.routes[${index}].sellCallLayout is unsupported`);
  }
  const pathMode = stringValue(input.pathMode, `exit.routes[${index}].pathMode`);
  if (pathMode !== "NONE" && pathMode !== "STATIC" && pathMode !== "TOKEN_PREFIX") {
    throw new TypeError(`exit.routes[${index}].pathMode is unsupported`);
  }
  const path = routePath(input.path, `exit.routes[${index}].path`);
  const pathRequired =
    quoteCallLayout === "TOKEN_IN_PATH" ||
    sellCallLayout === "TOKEN_IN_MIN_OUT_PATH_RECIPIENT_DEADLINE";
  if (!pathRequired && (pathMode !== "NONE" || path.length !== 0)) {
    throw new TypeError(`exit.routes[${index}] path must be empty when no call layout uses it`);
  }
  if (pathRequired && pathMode === "NONE") {
    throw new TypeError(`exit.routes[${index}].pathMode cannot be NONE for a path call`);
  }
  if (pathRequired && pathMode === "STATIC" && path.length < 2) {
    throw new TypeError(`exit.routes[${index}].path requires token and quote assets`);
  }
  if (pathRequired && pathMode === "TOKEN_PREFIX" && path.length < 1) {
    throw new TypeError(`exit.routes[${index}].path requires a quote-asset tail`);
  }
  const approvalSpenderMode = stringValue(
    input.approvalSpenderMode,
    `exit.routes[${index}].approvalSpenderMode`,
  );
  if (
    approvalSpenderMode !== "NONE" &&
    approvalSpenderMode !== "FIXED" &&
    approvalSpenderMode !== "ROUTE_TARGET"
  ) {
    throw new TypeError(`exit.routes[${index}].approvalSpenderMode is unsupported`);
  }
  const approvalSpender = optionalAddress(
    input.approvalSpender,
    `exit.routes[${index}].approvalSpender`,
  );
  if (allowanceMode === "NONE" && approvalSpenderMode !== "NONE") {
    throw new TypeError(`exit.routes[${index}] NONE allowance requires NONE spender mode`);
  }
  if (allowanceMode === "APPROVE" && approvalSpenderMode === "NONE") {
    throw new TypeError(`exit.routes[${index}] APPROVE requires an explicit spender mode`);
  }
  if (approvalSpenderMode === "FIXED" && approvalSpender === undefined) {
    throw new TypeError(`exit.routes[${index}].approvalSpender is required for FIXED mode`);
  }
  if (allowanceMode === "PERMIT") {
    throw new TypeError(`exit.routes[${index}] PERMIT is not implemented by this adapter`);
  }
  if (approvalSpenderMode !== "FIXED" && approvalSpender !== undefined) {
    throw new TypeError(`exit.routes[${index}].approvalSpender is only valid for FIXED mode`);
  }
  const quoteFunctionAbi = stringValue(
    input.quoteFunctionAbi,
    `exit.routes[${index}].quoteFunctionAbi`,
  );
  const sellFunctionAbi = stringValue(
    input.sellFunctionAbi,
    `exit.routes[${index}].sellFunctionAbi`,
  );
  let quoteFragment: FunctionFragment | null;
  let sellFragment: FunctionFragment | null;
  try {
    const quoteInterface = new Interface([quoteFunctionAbi]);
    const sellInterface = new Interface([sellFunctionAbi]);
    const quoteName = FunctionFragment.from(quoteFunctionAbi).name;
    const sellName = FunctionFragment.from(sellFunctionAbi).name;
    quoteFragment = quoteInterface.getFunction(quoteName);
    sellFragment = sellInterface.getFunction(sellName);
  } catch (error) {
    throw new TypeError(`exit.routes[${index}] contains an invalid function ABI`, { cause: error });
  }
  if (quoteFragment === null || sellFragment === null) {
    throw new TypeError(`exit.routes[${index}] function ABI could not be resolved`);
  }
  if (!["view", "pure"].includes(quoteFragment.stateMutability)) {
    throw new TypeError(`exit.routes[${index}] quote function must be read-only`);
  }
  if (sellFragment.stateMutability !== "nonpayable") {
    throw new TypeError(`exit.routes[${index}] sell function must be nonpayable`);
  }
  const quoteInputs = quoteFragment.inputs.map((parameter) => parameter.type);
  const expectedQuoteInputs =
    quoteCallLayout === "TOKEN_IN" ? ["uint256"] : ["uint256", "address[]"];
  if (
    quoteInputs.length !== expectedQuoteInputs.length ||
    quoteInputs.some((type, inputIndex) => type !== expectedQuoteInputs[inputIndex])
  ) {
    throw new TypeError(`exit.routes[${index}] quote ABI does not match quoteCallLayout`);
  }
  if (
    quoteFragment.outputs === null ||
    quoteFragment.outputs.length !== 1 ||
    !["uint256", "uint256[]"].includes(quoteFragment.outputs[0]?.type ?? "")
  ) {
    throw new TypeError(`exit.routes[${index}] quote ABI must return uint256 or uint256[]`);
  }
  const sellInputs = sellFragment.inputs.map((parameter) => parameter.type);
  const expectedSellInputs =
    sellCallLayout === "TOKEN_IN_MIN_OUT_RECIPIENT"
      ? ["uint256", "uint256", "address"]
      : ["uint256", "uint256", "address[]", "address", "uint256"];
  if (
    sellInputs.length !== expectedSellInputs.length ||
    sellInputs.some((type, inputIndex) => type !== expectedSellInputs[inputIndex])
  ) {
    throw new TypeError(`exit.routes[${index}] sell ABI does not match sellCallLayout`);
  }
  const approvalGasLimit = decimal(
    input.approvalGasLimit,
    `exit.routes[${index}].approvalGasLimit`,
    true,
  );
  if ((allowanceMode === "APPROVE") !== BigInt(approvalGasLimit) > 0n) {
    throw new TypeError(
      `exit.routes[${index}].approvalGasLimit must be positive exactly when APPROVE is used`,
    );
  }
  const maximumFeePerGasWei = decimal(
    input.maximumFeePerGasWei,
    `exit.routes[${index}].maximumFeePerGasWei`,
  );
  const maximumPriorityFeePerGasWei = decimal(
    input.maximumPriorityFeePerGasWei,
    `exit.routes[${index}].maximumPriorityFeePerGasWei`,
    true,
  );
  if (BigInt(maximumPriorityFeePerGasWei) > BigInt(maximumFeePerGasWei)) {
    throw new RangeError(`exit.routes[${index}] priority fee exceeds maximum fee`);
  }
  const quoteAsset = address(input.quoteAsset, `exit.routes[${index}].quoteAsset`);
  if (quoteAsset.toLowerCase() !== ZeroAddress.toLowerCase()) {
    throw new TypeError(`exit.routes[${index}] must return native ETH for receipt reconciliation`);
  }
  return Object.freeze({
    routeId: stringValue(input.routeId, `exit.routes[${index}].routeId`),
    routeKind,
    adapterId: stringValue(input.adapterId, `exit.routes[${index}].adapterId`),
    targetMode,
    ...(target === undefined ? {} : { target }),
    runtimeCodeHash: hex32(input.runtimeCodeHash, `exit.routes[${index}].runtimeCodeHash`),
    quoteAsset,
    allowanceMode,
    approvalSpenderMode,
    ...(approvalSpender === undefined ? {} : { approvalSpender }),
    quoteCallLayout,
    quoteOutputKind: "EXECUTABLE_BEFORE_GAS",
    sellCallLayout,
    pathMode,
    path,
    quoteFunctionAbi,
    sellFunctionAbi,
    approvalGasLimit,
    sellGasLimit: decimal(input.sellGasLimit, `exit.routes[${index}].sellGasLimit`),
    maximumFeePerGasWei,
    maximumPriorityFeePerGasWei,
    quoteMaximumAgeMs: integer(
      input.quoteMaximumAgeMs,
      `exit.routes[${index}].quoteMaximumAgeMs`,
      1,
    ),
    evidenceIds: stringArray(input.evidenceIds, `exit.routes[${index}].evidenceIds`),
  });
}

export function freezeProductionProfile(draft: ProductionProfileDraft): ProductionProtocolProfile {
  return Object.freeze({ ...draft, profileHash: stableHash(draft) });
}

export function parseProductionProfile(value: unknown): ProductionProtocolProfile {
  const input = record(value, "production profile");
  if (input.formatVersion !== 1) throw new TypeError("profile formatVersion must be 1");
  if (input.chainId !== 4_663) throw new TypeError("profile chainId must be 4663");
  if (input.adapterId !== SUPPORTED_PRODUCTION_ADAPTER) {
    throw new TypeError(`unsupported production adapter ${String(input.adapterId)}`);
  }
  const factoryInput = record(input.factory, "factory");
  const identityInput = record(input.identity, "identity");
  const mechanismInput = record(input.mechanism, "mechanism");
  const entryInput = record(input.entry, "entry");
  const exitInput = record(input.exit, "exit");
  const launchEventTopic = hex32(factoryInput.launchEventTopic, "factory.launchEventTopic");
  const launchFields = parseLaunchFields(factoryInput.launchFields);
  const routeValues = exitInput.routes;
  if (!Array.isArray(routeValues)) throw new TypeError("exit.routes must be an array");
  const capScope = stringValue(mechanismInput.capScope, "mechanism.capScope");
  if (capScope !== "PER_TX" && capScope !== "PER_WALLET" && capScope !== "GLOBAL") {
    throw new TypeError("mechanism.capScope must be explicit");
  }
  const cooldownScope = stringValue(mechanismInput.cooldownScope, "mechanism.cooldownScope");
  if (cooldownScope !== "PER_WALLET" && cooldownScope !== "GLOBAL" && cooldownScope !== "NONE") {
    throw new TypeError("mechanism.cooldownScope must be explicit");
  }
  if (mechanismInput.kind !== "CLOCKIN_40PCT_2MIN_V1") {
    throw new TypeError("production mechanism must be CLOCKIN_40PCT_2MIN_V1");
  }
  if (mechanismInput.decayModel !== "LINEAR_TIME") {
    throw new TypeError("production mechanism decayModel must be LINEAR_TIME");
  }
  const maximumInitialFeeBps = integer(
    mechanismInput.maximumInitialFeeBps,
    "mechanism.maximumInitialFeeBps",
  );
  const floorFeeBps = integer(mechanismInput.floorFeeBps, "mechanism.floorFeeBps");
  if (maximumInitialFeeBps !== 4_000 || floorFeeBps !== 0) {
    throw new RangeError("ClockIn production requires an exact 4000 bps to 0 bps fee profile");
  }
  const quoteAsset = address(mechanismInput.quoteAsset, "mechanism.quoteAsset");
  if (quoteAsset.toLowerCase() !== ZeroAddress.toLowerCase()) {
    throw new TypeError("the supported production adapter requires native ETH quoteAsset");
  }
  const implementationAddress = optionalAddress(
    factoryInput.implementationAddress,
    "factory.implementationAddress",
  );
  const implementationCodeHash =
    factoryInput.implementationCodeHash === undefined
      ? undefined
      : hex32(factoryInput.implementationCodeHash, "factory.implementationCodeHash");
  if ((implementationAddress === undefined) !== (implementationCodeHash === undefined)) {
    throw new TypeError("factory implementation address and code hash must be supplied together");
  }
  const expectedCreator = optionalAddress(
    identityInput.expectedCreator,
    "identity.expectedCreator",
  );
  const metadataIncludes = optionalText(
    identityInput.metadataIncludes,
    "identity.metadataIncludes",
  );
  const requiredTokenSuffix = optionalText(
    identityInput.requiredTokenSuffix,
    "identity.requiredTokenSuffix",
  );
  const officialCaInput = record(identityInput.officialCa, "identity.officialCa");
  const draft: ProductionProfileDraft = Object.freeze({
    formatVersion: 1,
    profileId: stringValue(input.profileId, "profileId"),
    revision: integer(input.revision, "revision", 1),
    chainId: 4_663,
    adapterId: SUPPORTED_PRODUCTION_ADAPTER,
    factory: Object.freeze({
      address: address(factoryInput.address, "factory.address"),
      runtimeCodeHash: hex32(factoryInput.runtimeCodeHash, "factory.runtimeCodeHash"),
      ...(implementationAddress === undefined ? {} : { implementationAddress }),
      ...(implementationCodeHash === undefined ? {} : { implementationCodeHash }),
      startBlock: decimal(factoryInput.startBlock, "factory.startBlock", true),
      launchEventAbi: validateEventAbi(factoryInput.launchEventAbi, launchEventTopic, launchFields),
      launchEventTopic,
      launchFields,
    }),
    identity: Object.freeze({
      expectedName: stringValue(identityInput.expectedName, "identity.expectedName"),
      expectedSymbol: stringValue(identityInput.expectedSymbol, "identity.expectedSymbol"),
      ...(expectedCreator === undefined ? {} : { expectedCreator }),
      ...(metadataIncludes === undefined ? {} : { metadataIncludes }),
      ...(requiredTokenSuffix === undefined ? {} : { requiredTokenSuffix }),
      officialCa: Object.freeze({
        url: httpsUrl(officialCaInput.url, "identity.officialCa.url"),
        jsonKey: stringValue(officialCaInput.jsonKey, "identity.officialCa.jsonKey"),
        pollMs: integer(officialCaInput.pollMs, "identity.officialCa.pollMs", 250),
      }),
    }),
    mechanism: Object.freeze({
      profileId: stringValue(mechanismInput.profileId, "mechanism.profileId"),
      revision: integer(mechanismInput.revision, "mechanism.revision", 1),
      kind: "CLOCKIN_40PCT_2MIN_V1",
      maximumInitialFeeBps,
      floorFeeBps,
      decayWindowSeconds: integer(
        mechanismInput.decayWindowSeconds,
        "mechanism.decayWindowSeconds",
        1,
      ),
      decayModel: "LINEAR_TIME",
      capScope,
      cooldownScope,
      quoteAsset,
      poolRuntimeCodeHashes: addressArray(
        mechanismInput.poolRuntimeCodeHashes,
        "mechanism.poolRuntimeCodeHashes",
      ),
      tokenRuntimeCodeHashes: addressArray(
        mechanismInput.tokenRuntimeCodeHashes,
        "mechanism.tokenRuntimeCodeHashes",
      ),
      functions: parseFunctions(mechanismInput.functions),
    }),
    entry: Object.freeze({
      refCode: hex32(entryInput.refCode, "entry.refCode"),
      gasLimit: decimal(entryInput.gasLimit, "entry.gasLimit"),
      maximumFeePerGasWei: decimal(entryInput.maximumFeePerGasWei, "entry.maximumFeePerGasWei"),
      maximumPriorityFeePerGasWei: decimal(
        entryInput.maximumPriorityFeePerGasWei,
        "entry.maximumPriorityFeePerGasWei",
        true,
      ),
      quoteMaximumAgeMs: integer(entryInput.quoteMaximumAgeMs, "entry.quoteMaximumAgeMs", 1),
      laterLaneMaximumDriftBps: integer(
        entryInput.laterLaneMaximumDriftBps,
        "entry.laterLaneMaximumDriftBps",
      ),
      canaryMinimumOutputRaw: decimal(
        entryInput.canaryMinimumOutputRaw,
        "entry.canaryMinimumOutputRaw",
      ),
      maximumExecutionDriftBps: integer(
        entryInput.maximumExecutionDriftBps,
        "entry.maximumExecutionDriftBps",
      ),
    }),
    exit: Object.freeze({ routes: Object.freeze(routeValues.map(parseRoute)) }),
    evidenceIds: stringArray(input.evidenceIds, "evidenceIds"),
    createdAt: iso(input.createdAt, "createdAt"),
  });
  if (draft.mechanism.decayWindowSeconds !== 120) {
    throw new RangeError("ClockIn production requires an exact 120-second decay window");
  }
  if (new Set(draft.exit.routes.map((route) => route.routeId)).size !== draft.exit.routes.length) {
    throw new TypeError("production exit route IDs must be unique");
  }
  if (BigInt(draft.entry.maximumPriorityFeePerGasWei) > BigInt(draft.entry.maximumFeePerGasWei)) {
    throw new RangeError("entry priority fee exceeds maximum fee");
  }
  for (const value of [
    draft.entry.laterLaneMaximumDriftBps,
    draft.entry.maximumExecutionDriftBps,
  ]) {
    if (value < 0 || value >= 10_000) throw new RangeError("entry drift bps must be in 0..9999");
  }
  const expectedHash = stableHash(draft);
  const providedHash = stringValue(input.profileHash, "profileHash");
  if (providedHash !== expectedHash) throw new Error("production profile hash mismatch");
  return Object.freeze({ ...draft, profileHash: expectedHash });
}

export function productionWalletManifestHash(manifest: WalletManifest): string {
  if (manifest.entries.length !== 10)
    throw new RangeError("production wallet manifest requires 10 entries");
  return stableHash({
    revision: manifest.revision,
    entries: manifest.entries.map((entry) => ({
      walletId: entry.walletId,
      address: getAddress(entry.address),
      role: entry.role,
      expectedChainId: entry.expectedChainId,
    })),
  });
}

export function productionAuthorizationBinding(
  profile: ProductionAuthorizationProfileRef,
  manifest: WalletManifest,
): Readonly<{ walletManifestHash: string; scopeHash: string; riskEnvelopeHash: string }> {
  const walletManifestHash = productionWalletManifestHash(manifest);
  const scopeHash = stableHash({
    chainId: 4_663,
    profileId: profile.profileId,
    profileRevision: profile.revision,
    profileHash: profile.profileHash,
    strategyConfigHash: CLOCKIN_POLICY_V2.configHash,
    walletManifestHash,
    budgetUsdMicros: CLOCKIN_POLICY_V2.clockInBudgetUsdMicros.toString(),
    laneCount: CLOCKIN_POLICY_V2.laneCount,
  });
  const riskEnvelopeHash = stableHash({
    allInRiskCapUsdMicros: CLOCKIN_POLICY_V2.allInRiskCapUsdMicros.toString(),
    nominalLaneUsdMicros: CLOCKIN_POLICY_V2.nominalLaneUsdMicros.toString(),
    minimumShrunkLaneUsdMicros: CLOCKIN_POLICY_V2.minimumShrunkLaneUsdMicros.toString(),
    capPolicy: CLOCKIN_POLICY_V2.capPolicy,
    caGateMode: CLOCKIN_POLICY_V2.caGateMode,
    routineExitMaximumSlippageBps: CLOCKIN_POLICY_V2.routineExitMaximumSlippageBps,
    breakGlassExitMaximumSlippageBps: CLOCKIN_POLICY_V2.breakGlassExitMaximumSlippageBps,
    maximumSellTransactionsPerWallet: CLOCKIN_POLICY_V2.maximumSellTransactionsPerWallet,
    automaticTopUpPolicy: CLOCKIN_POLICY_V2.automaticTopUpPolicy,
    boundedCanaryPolicyHash: BOUNDED_CANARY_POLICY_HASH,
  });
  return Object.freeze({ walletManifestHash, scopeHash, riskEnvelopeHash });
}

export function createProductionAuthorization(input: {
  readonly authorizationId: string;
  readonly actorRef: string;
  readonly profile: ProductionAuthorizationProfileRef;
  readonly manifest: WalletManifest;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly evidenceIds: readonly string[];
  readonly reason: string;
}): ProductionAuthorization {
  const binding = productionAuthorizationBinding(input.profile, input.manifest);
  return parseProductionAuthorization(
    {
      formatVersion: 1,
      authorizationId: input.authorizationId,
      mode: "AUTO_POLICY",
      actorRef: input.actorRef,
      policyId: "clockin-policy-v2",
      policyVersion: "2",
      profileId: input.profile.profileId,
      profileRevision: input.profile.revision,
      profileHash: input.profile.profileHash,
      strategyConfigHash: CLOCKIN_POLICY_V2.configHash,
      ...binding,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      evidenceIds: input.evidenceIds,
      reason: input.reason,
    },
    input.profile,
    input.manifest,
    input.issuedAt,
  );
}

export function parseProductionAuthorization(
  value: unknown,
  profile: ProductionAuthorizationProfileRef,
  manifest: WalletManifest,
  now = new Date().toISOString(),
): ProductionAuthorization {
  const input = record(value, "production authorization");
  const binding = productionAuthorizationBinding(profile, manifest);
  const issuedAt = iso(input.issuedAt, "authorization.issuedAt");
  const expiresAt = iso(input.expiresAt, "authorization.expiresAt");
  const issuedMs = Date.parse(issuedAt);
  const expiresMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs))
    throw new TypeError("authorization validation time must be ISO-8601");
  if (expiresMs <= issuedMs) throw new RangeError("authorization expiry must follow issue time");
  if (expiresMs - issuedMs > CLOCKIN_POLICY_V2.authorizationMaximumTtlMs) {
    throw new RangeError("authorization exceeds the seven-day maximum TTL");
  }
  if (issuedMs > nowMs) throw new Error("production authorization is not active yet");
  if (expiresMs <= nowMs) throw new Error("production authorization is expired");
  const authorization: ProductionAuthorization = Object.freeze({
    formatVersion: 1,
    authorizationId: stringValue(input.authorizationId, "authorization.authorizationId"),
    mode: "AUTO_POLICY",
    actorRef: stringValue(input.actorRef, "authorization.actorRef"),
    policyId: "clockin-policy-v2",
    policyVersion: "2",
    profileId: stringValue(input.profileId, "authorization.profileId"),
    profileRevision: integer(input.profileRevision, "authorization.profileRevision", 1),
    profileHash: stringValue(input.profileHash, "authorization.profileHash"),
    strategyConfigHash: stringValue(input.strategyConfigHash, "authorization.strategyConfigHash"),
    walletManifestHash: stringValue(input.walletManifestHash, "authorization.walletManifestHash"),
    scopeHash: stringValue(input.scopeHash, "authorization.scopeHash"),
    riskEnvelopeHash: stringValue(input.riskEnvelopeHash, "authorization.riskEnvelopeHash"),
    issuedAt,
    expiresAt,
    evidenceIds: stringArray(input.evidenceIds, "authorization.evidenceIds"),
    reason: stringValue(input.reason, "authorization.reason"),
  });
  if (
    input.formatVersion !== 1 ||
    input.mode !== "AUTO_POLICY" ||
    input.policyId !== "clockin-policy-v2" ||
    String(input.policyVersion) !== "2"
  ) {
    throw new TypeError("authorization policy identity is invalid");
  }
  if (
    authorization.profileId !== profile.profileId ||
    authorization.profileRevision !== profile.revision ||
    authorization.profileHash !== profile.profileHash ||
    authorization.strategyConfigHash !== CLOCKIN_POLICY_V2.configHash ||
    authorization.walletManifestHash !== binding.walletManifestHash ||
    authorization.scopeHash !== binding.scopeHash ||
    authorization.riskEnvelopeHash !== binding.riskEnvelopeHash
  ) {
    throw new Error("production authorization scope or risk envelope mismatch");
  }
  return authorization;
}
