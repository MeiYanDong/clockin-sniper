import { getAddress, Interface, isHexString, keccak256, MaxUint256, ZeroAddress } from "ethers";

import { type Address, CanonicalInvariantError, stableHash } from "../core/canonical.js";
import type { PoolObservation, PoolReadAdapter } from "../entry/pool-observation.js";
import { observePoolAt } from "../entry/pool-observation.js";
import { quantityToHex } from "../rpc/hex.js";
import type { Hex, JsonRpcRequester } from "../rpc/types.js";
import type { RpcContractLog } from "../rpc/websocket-logs.js";
import type { EntryTransactionTemplate } from "./protocol-contracts.js";

export const STONK_SAFE_LAUNCH_QUOTED_ADAPTER_ID = "stonk.safe-launch-quoted-mainnet-v1" as const;
export const STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS =
  "0xABEa69101B2a19347A34339F24cAD8b9523E9c29" as const;
export const STONK_SAFE_LAUNCH_WETH_FACTORY_RUNTIME_CODE_HASH =
  "0x8e29dcdde3a878f2384cbda5c2300e77d7fea299b79def5fd1be9d5700deda53" as const;
export const STONK_SAFE_LAUNCH_STONK_FACTORY_ADDRESS =
  "0x77103B69f680BCd3df75F7D7ed3a67030130736a" as const;
export const STONK_SAFE_LAUNCH_STONK_FACTORY_RUNTIME_CODE_HASH =
  "0xc882dad9fed3441fac7f87394780f86a78ffb92443b85a17039d3cdcd1dc49f4" as const;
export const CLOCKIN_APPROVED_LAUNCH_CREATOR =
  "0x5eb8d8492b6b710f29b72a0bbd6425241d408e06" as const;
export const ROBINHOOD_WETH_ADDRESS = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
export const ROBINHOOD_WETH_RUNTIME_CODE_HASH =
  "0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353" as const;
export const SAFE_LAUNCH_BUFFER_TAX_BPS = 9_999;

/**
 * The verified quoted-pad source has no per-transaction, per-wallet or global buy cap and no
 * buy cooldown. `_tradeGates` enforces lifecycle/deadline and direct-EOA access instead. Bind the
 * negative source finding to the frozen runtime hash so an unknown mechanism can never inherit
 * these permissive values after bytecode drift.
 */
export const STONK_SAFE_LAUNCH_QUOTED_BUY_LIMIT_POLICY = Object.freeze({
  capScope: "NO_CAP" as const,
  capRaw: MaxUint256,
  cooldownScope: "NONE" as const,
  cooldownSeconds: 0 as const,
  evidenceRuntimeCodeHash: STONK_SAFE_LAUNCH_WETH_FACTORY_RUNTIME_CODE_HASH,
});

export const STONK_SAFE_LAUNCH_QUOTED_CREATED_EVENT_ABI =
  "event LaunchCreated(uint256 indexed id,address indexed token,address indexed creator,bool externalToken)";
export const STONK_SAFE_LAUNCH_QUOTED_ARMED_EVENT_ABI =
  "event LaunchArmed(uint256 indexed id,uint256 supply,uint256 vQuote0,uint64 quoteUsd8,uint64 deadline)";
export const STONK_SAFE_LAUNCH_QUOTED_GET_LAUNCH_ABI =
  "function getLaunch(uint256 id) view returns ((address token,address creator,uint64 startMcapUsd8,uint64 gradMcapUsd8,uint16 startTaxBps,uint16 decayPerMinuteBps,uint16 creatorFeeBpsSnap,uint16 protocolFeeBpsSnap,uint32 windowSecs,uint64 startTime,uint64 deadline,bool externalToken,bool sellsEnabled,bool armed,bool graduated,bool bonded,bool aborted,uint256 loadedSupply,uint256 vQuote,uint256 vToken,uint256 realQuote,uint256 buyCount))";
export const STONK_SAFE_LAUNCH_QUOTED_VIEW_LAUNCH_ABI =
  "function viewLaunch(uint256 id) view returns ((uint256 id,(address token,address creator,uint64 startMcapUsd8,uint64 gradMcapUsd8,uint16 startTaxBps,uint16 decayPerMinuteBps,uint16 creatorFeeBpsSnap,uint16 protocolFeeBpsSnap,uint32 windowSecs,uint64 startTime,uint64 deadline,bool externalToken,bool sellsEnabled,bool armed,bool graduated,bool bonded,bool aborted,uint256 loadedSupply,uint256 vQuote,uint256 vToken,uint256 realQuote,uint256 buyCount) core,uint256 taxBps,uint256 mcapUsd8Now,uint256 tokensSold,bool oracleFresh,address[] legs,address[] pools,uint256[] lockIds,uint256 lpQuote,uint16 lpFeeBpsSnap,uint64 closedAtTs,uint32 bufferSecs) v)";
export const STONK_SAFE_LAUNCH_QUOTED_ABI = Object.freeze([
  STONK_SAFE_LAUNCH_QUOTED_CREATED_EVENT_ABI,
  STONK_SAFE_LAUNCH_QUOTED_ARMED_EVENT_ABI,
  STONK_SAFE_LAUNCH_QUOTED_GET_LAUNCH_ABI,
  STONK_SAFE_LAUNCH_QUOTED_VIEW_LAUNCH_ABI,
  "function bufferSecsOf(uint256 id) view returns (uint32)",
  "function quote() view returns (address)",
  "function quoteBuy(uint256 id,uint256 quoteIn) view returns (uint256 tokensOut,uint256 taxBps)",
  "function currentTaxBps(uint256 id) view returns (uint256)",
  "function buy(uint256 id,uint256 quoteIn,uint256 minTokensOut,bytes32 ref) returns (uint256 tokensOut)",
]);

const quotedInterface = new Interface(STONK_SAFE_LAUNCH_QUOTED_ABI);
const erc20Interface = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
const createdFragment = quotedInterface.getEvent("LaunchCreated");
const armedFragment = quotedInterface.getEvent("LaunchArmed");
if (createdFragment === null || armedFragment === null) {
  throw new Error("quoted Safe Launch event ABI is unavailable");
}

export const STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC = createdFragment.topicHash as Hex;
export const STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC = armedFragment.topicHash as Hex;

export interface StonkSafeLaunchQuotedProfile {
  readonly factoryAddress: Address;
  readonly factoryRuntimeCodeHash: Hex;
  readonly quoteAsset: Address;
  readonly quoteAssetRuntimeCodeHash: Hex;
  readonly startBlock: bigint;
}

export const CLOCKIN_WETH_SAFE_LAUNCH_PROFILE: StonkSafeLaunchQuotedProfile = Object.freeze({
  factoryAddress: STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
  factoryRuntimeCodeHash: STONK_SAFE_LAUNCH_WETH_FACTORY_RUNTIME_CODE_HASH,
  quoteAsset: ROBINHOOD_WETH_ADDRESS,
  quoteAssetRuntimeCodeHash: ROBINHOOD_WETH_RUNTIME_CODE_HASH,
  startBlock: 40_100_279n,
});

interface EventRef {
  readonly factoryAddress: Address;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: bigint;
}

export interface StonkSafeLaunchQuotedCreated extends EventRef {
  readonly kind: "LaunchCreated";
  readonly id: bigint;
  readonly tokenAddress: Address;
  readonly creatorAddress: Address;
  readonly externalToken: boolean;
}

export interface StonkSafeLaunchQuotedArmed extends EventRef {
  readonly kind: "LaunchArmed";
  readonly id: bigint;
  readonly supply: bigint;
  readonly virtualQuoteInitial: bigint;
  readonly quoteUsd8: bigint;
  readonly deadline: bigint;
}

export interface StonkSafeLaunchQuotedState {
  readonly id: bigint;
  readonly tokenAddress: Address;
  readonly creatorAddress: Address;
  readonly startMcapUsd8: bigint;
  readonly graduationMcapUsd8: bigint;
  readonly startTaxBps: number;
  readonly decayPerMinuteBps: number;
  readonly creatorFeeBps: number;
  readonly protocolFeeBps: number;
  readonly windowSeconds: number;
  readonly bufferSeconds: number;
  readonly startTime: bigint;
  readonly deadline: bigint;
  readonly externalToken: boolean;
  readonly sellsEnabled: boolean;
  readonly armed: boolean;
  readonly graduated: boolean;
  readonly bonded: boolean;
  readonly aborted: boolean;
  readonly loadedSupply: bigint;
  readonly virtualQuote: bigint;
  readonly virtualToken: bigint;
  readonly realQuote: bigint;
  readonly buyCount: bigint;
}

export interface StonkSafeLaunchQuotedQuote {
  readonly id: bigint;
  readonly quoteIn: bigint;
  readonly tokensOut: bigint;
  readonly taxBps: number;
  readonly blockNumber: bigint;
}

export interface StonkSafeLaunchQuoteSpendReadiness {
  readonly walletAddress: Address;
  readonly quoteAsset: Address;
  readonly factoryAddress: Address;
  readonly balanceRaw: bigint;
  readonly allowanceRaw: bigint;
  readonly requiredRaw: bigint;
  readonly ready: boolean;
}

type StonkSafeLaunchTaxWindow = Readonly<
  Pick<
    StonkSafeLaunchQuotedState,
    | "startTaxBps"
    | "decayPerMinuteBps"
    | "windowSeconds"
    | "bufferSeconds"
    | "startTime"
    | "deadline"
  >
>;

function assertValidStonkSafeLaunchTaxWindow(launch: StonkSafeLaunchTaxWindow): void {
  if (launch.startTaxBps <= 0 || launch.decayPerMinuteBps <= 0 || launch.windowSeconds <= 0) {
    throw new CanonicalInvariantError("POOL_STATE_INVALID", "launch tax schedule is empty");
  }
  const expectedDeadline =
    launch.startTime + BigInt(launch.bufferSeconds) + BigInt(launch.windowSeconds);
  if (launch.deadline !== expectedDeadline) {
    throw new CanonicalInvariantError(
      "POOL_STATE_INVALID",
      "launch deadline is inconsistent with start, buffer and tax window",
    );
  }
}

/**
 * `_tradeGates` rejects at `timestamp >= deadline`, so the last executable schedule point is
 * `deadline - 1`. Integer-minute decay therefore has `floor((windowSecs - 1) / 60)` steps.
 * Irregular schedules and an executable zero-tax state are both valid and must not be rounded
 * into a stricter policy than the verified contract actually enforces.
 */
export function minimumReachableStonkSafeLaunchTaxBps(launch: StonkSafeLaunchTaxWindow): number {
  assertValidStonkSafeLaunchTaxWindow(launch);
  const maximumExecutableMinute = Math.floor((launch.windowSeconds - 1) / 60);
  return Math.max(0, launch.startTaxBps - maximumExecutableMinute * launch.decayPerMinuteBps);
}

export function isReachableStonkSafeLaunchTaxBps(
  launch: StonkSafeLaunchTaxWindow,
  taxBps: number,
): boolean {
  if (!Number.isSafeInteger(taxBps)) return false;
  const minimum = minimumReachableStonkSafeLaunchTaxBps(launch);
  if (taxBps < minimum || taxBps > launch.startTaxBps) return false;
  if (taxBps === 0) return minimum === 0;
  const difference = launch.startTaxBps - taxBps;
  return difference % launch.decayPerMinuteBps === 0;
}

function uint(value: unknown, label: string): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(String(value));
  } catch (error) {
    throw new TypeError(`${label} is not an integer`, { cause: error });
  }
  if (parsed < 0n || parsed > MaxUint256) throw new RangeError(`${label} is not uint256`);
  return parsed;
}

function positive(value: unknown, label: string): bigint {
  const parsed = uint(value, label);
  if (parsed === 0n) throw new RangeError(`${label} must be positive`);
  return parsed;
}

function safeNumber(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = uint(value, label);
  if (parsed > BigInt(maximum)) throw new RangeError(`${label} exceeds ${maximum}`);
  return Number(parsed);
}

function checkedAddress(value: unknown, label: string): Address {
  const parsed = getAddress(String(value)) as Address;
  if (parsed.toLowerCase() === ZeroAddress.toLowerCase()) {
    throw new Error(`${label} must not be zero`);
  }
  return parsed;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} is not boolean`);
  return value;
}

function eventRef(log: RpcContractLog, profile: StonkSafeLaunchQuotedProfile): EventRef {
  return Object.freeze({
    factoryAddress: profile.factoryAddress,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
  });
}

function parseEvent(
  log: RpcContractLog,
  profile: StonkSafeLaunchQuotedProfile,
  name: "LaunchCreated" | "LaunchArmed",
  topic: Hex,
  topicCount: number,
): NonNullable<ReturnType<Interface["parseLog"]>> {
  if (log.removed) {
    throw new CanonicalInvariantError("REORG_DETECTED", `removed ${name} log is not canonical`);
  }
  if (log.address.toLowerCase() !== profile.factoryAddress.toLowerCase()) {
    throw new CanonicalInvariantError("IDENTITY_CONFLICT", `${name} emitter is not the bound pad`);
  }
  if (log.topics.length !== topicCount || log.topics[0]?.toLowerCase() !== topic.toLowerCase()) {
    throw new CanonicalInvariantError("IDENTITY_CONFLICT", `${name} topic/layout is invalid`);
  }
  const parsed = quotedInterface.parseLog({ topics: [...log.topics], data: log.data });
  if (parsed === null || parsed.name !== name) throw new Error(`${name} ABI decode failed`);
  return parsed;
}

export function decodeStonkSafeLaunchQuotedCreated(
  log: RpcContractLog,
  profile: StonkSafeLaunchQuotedProfile = CLOCKIN_WETH_SAFE_LAUNCH_PROFILE,
): StonkSafeLaunchQuotedCreated {
  const parsed = parseEvent(
    log,
    profile,
    "LaunchCreated",
    STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
    4,
  );
  const id = positive(parsed.args.id, "launch id");
  const externalToken = boolean(parsed.args.externalToken, "externalToken");
  return Object.freeze({
    ...eventRef(log, profile),
    kind: "LaunchCreated",
    id,
    tokenAddress: checkedAddress(parsed.args.token, "launch token"),
    creatorAddress: checkedAddress(parsed.args.creator, "launch creator"),
    externalToken,
  });
}

export function decodeStonkSafeLaunchQuotedArmed(
  log: RpcContractLog,
  profile: StonkSafeLaunchQuotedProfile = CLOCKIN_WETH_SAFE_LAUNCH_PROFILE,
): StonkSafeLaunchQuotedArmed {
  const parsed = parseEvent(log, profile, "LaunchArmed", STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC, 2);
  return Object.freeze({
    ...eventRef(log, profile),
    kind: "LaunchArmed",
    id: positive(parsed.args.id, "launch id"),
    supply: positive(parsed.args.supply, "armed supply"),
    virtualQuoteInitial: positive(parsed.args.vQuote0, "armed virtual quote"),
    quoteUsd8: positive(parsed.args.quoteUsd8, "armed quote USD price"),
    deadline: positive(parsed.args.deadline, "armed deadline"),
  });
}

async function exactCall(
  requester: JsonRpcRequester,
  target: Address,
  contract: Interface,
  functionName: string,
  args: readonly unknown[],
  blockNumber: bigint,
): Promise<readonly unknown[]> {
  if (blockNumber < 0n) throw new RangeError("exact block number must not be negative");
  const raw = await requester.request<string>("eth_call", [
    { to: target, data: contract.encodeFunctionData(functionName, [...args]) },
    quantityToHex(blockNumber),
  ]);
  if (!isHexString(raw)) throw new TypeError(`${functionName} returned invalid ABI data`);
  try {
    return contract.decodeFunctionResult(functionName, raw);
  } catch (error) {
    throw new Error(`${functionName} result does not decode`, { cause: error });
  }
}

function scalar(result: readonly unknown[], label: string): unknown {
  if (result.length !== 1) throw new Error(`${label} must return exactly one value`);
  return result[0];
}

interface RpcBlock {
  readonly number?: unknown;
  readonly hash?: unknown;
  readonly timestamp?: unknown;
}

function rpcQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u.test(value)) {
    throw new TypeError(`${label} is not a canonical RPC quantity`);
  }
  return BigInt(value);
}

function hex32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHexString(value, 32)) {
    throw new TypeError(`${label} is not 32-byte hex`);
  }
  return value as Hex;
}

export async function verifyStonkSafeLaunchQuotedProfile(
  requester: JsonRpcRequester,
  profile: StonkSafeLaunchQuotedProfile = CLOCKIN_WETH_SAFE_LAUNCH_PROFILE,
  blockNumber: bigint | "latest" = "latest",
): Promise<void> {
  const blockTag = blockNumber === "latest" ? "latest" : quantityToHex(blockNumber);
  const exactBlock = blockNumber === "latest" ? await latestBlockNumber(requester) : blockNumber;
  const [factoryCode, quoteCode, quoteResult] = await Promise.all([
    requester.request<string>("eth_getCode", [profile.factoryAddress, blockTag]),
    requester.request<string>("eth_getCode", [profile.quoteAsset, blockTag]),
    exactCall(requester, profile.factoryAddress, quotedInterface, "quote", [], exactBlock),
  ]);
  if (
    !isHexString(factoryCode) ||
    factoryCode === "0x" ||
    !isHexString(quoteCode) ||
    quoteCode === "0x"
  ) {
    throw new Error("Safe Launch pad or quote asset has empty code");
  }
  if (keccak256(factoryCode).toLowerCase() !== profile.factoryRuntimeCodeHash.toLowerCase()) {
    throw new CanonicalInvariantError("FACTORY_CODE_DRIFT", "quoted Safe Launch runtime drifted");
  }
  if (keccak256(quoteCode).toLowerCase() !== profile.quoteAssetRuntimeCodeHash.toLowerCase()) {
    throw new CanonicalInvariantError("PROFILE_STALE", "quoted asset runtime drifted");
  }
  const observedQuote = checkedAddress(scalar(quoteResult, "quote"), "pad quote asset");
  if (observedQuote.toLowerCase() !== profile.quoteAsset.toLowerCase()) {
    throw new CanonicalInvariantError("IDENTITY_CONFLICT", "pad quote asset changed");
  }
}

async function latestBlockNumber(requester: JsonRpcRequester): Promise<bigint> {
  return rpcQuantity(await requester.request<string>("eth_blockNumber"), "eth_blockNumber");
}

export class StonkSafeLaunchQuotedAdapter {
  readonly adapterId = STONK_SAFE_LAUNCH_QUOTED_ADAPTER_ID;
  readonly profile: StonkSafeLaunchQuotedProfile;
  readonly #requester: JsonRpcRequester;

  constructor(
    requester: JsonRpcRequester,
    profile: StonkSafeLaunchQuotedProfile = CLOCKIN_WETH_SAFE_LAUNCH_PROFILE,
  ) {
    this.#requester = requester;
    this.profile = profile;
  }

  async readLaunch(id: bigint, blockNumber: bigint): Promise<StonkSafeLaunchQuotedState> {
    const validId = positive(id, "launch id");
    const [launchResult, bufferResult] = await Promise.all([
      exactCall(
        this.#requester,
        this.profile.factoryAddress,
        quotedInterface,
        "getLaunch",
        [validId],
        blockNumber,
      ),
      exactCall(
        this.#requester,
        this.profile.factoryAddress,
        quotedInterface,
        "bufferSecsOf",
        [validId],
        blockNumber,
      ),
    ]);
    const launch = scalar(launchResult, "getLaunch") as Record<string, unknown>;
    const state = Object.freeze({
      id: validId,
      tokenAddress: checkedAddress(launch.token, "launch token"),
      creatorAddress: checkedAddress(launch.creator, "launch creator"),
      startMcapUsd8: positive(launch.startMcapUsd8, "start market cap"),
      graduationMcapUsd8: positive(launch.gradMcapUsd8, "graduation market cap"),
      startTaxBps: safeNumber(launch.startTaxBps, "start tax", 10_000),
      decayPerMinuteBps: safeNumber(launch.decayPerMinuteBps, "tax decay", 10_000),
      creatorFeeBps: safeNumber(launch.creatorFeeBpsSnap, "creator fee", 10_000),
      protocolFeeBps: safeNumber(launch.protocolFeeBpsSnap, "protocol fee", 10_000),
      windowSeconds: safeNumber(launch.windowSecs, "window seconds"),
      bufferSeconds: safeNumber(scalar(bufferResult, "bufferSecsOf"), "buffer seconds"),
      startTime: uint(launch.startTime, "start time"),
      deadline: uint(launch.deadline, "deadline"),
      externalToken: boolean(launch.externalToken, "external token"),
      sellsEnabled: boolean(launch.sellsEnabled, "sells enabled"),
      armed: boolean(launch.armed, "armed"),
      graduated: boolean(launch.graduated, "graduated"),
      bonded: boolean(launch.bonded, "bonded"),
      aborted: boolean(launch.aborted, "aborted"),
      loadedSupply: uint(launch.loadedSupply, "loaded supply"),
      virtualQuote: uint(launch.vQuote, "virtual quote"),
      virtualToken: uint(launch.vToken, "virtual token"),
      realQuote: uint(launch.realQuote, "real quote"),
      buyCount: uint(launch.buyCount, "buy count"),
    });
    minimumReachableStonkSafeLaunchTaxBps(state);
    return state;
  }

  async quoteBuy(
    id: bigint,
    quoteIn: bigint,
    blockNumber: bigint,
  ): Promise<StonkSafeLaunchQuotedQuote> {
    const validId = positive(id, "launch id");
    const validQuoteIn = positive(quoteIn, "quote input");
    const result = await exactCall(
      this.#requester,
      this.profile.factoryAddress,
      quotedInterface,
      "quoteBuy",
      [validId, validQuoteIn],
      blockNumber,
    );
    if (result.length !== 2) throw new Error("quoteBuy must return two values");
    const tokensOut = positive(result[0], "quote tokens out");
    return Object.freeze({
      id: validId,
      quoteIn: validQuoteIn,
      tokensOut,
      taxBps: safeNumber(result[1], "quote tax", 10_000),
      blockNumber,
    });
  }

  async oracleFresh(id: bigint, blockNumber: bigint): Promise<boolean> {
    const result = await exactCall(
      this.#requester,
      this.profile.factoryAddress,
      quotedInterface,
      "viewLaunch",
      [positive(id, "launch id")],
      blockNumber,
    );
    const view = scalar(result, "viewLaunch") as Record<string, unknown>;
    return boolean(view.oracleFresh, "launch oracle freshness");
  }

  async currentTaxBps(id: bigint, blockNumber: bigint): Promise<number> {
    const result = await exactCall(
      this.#requester,
      this.profile.factoryAddress,
      quotedInterface,
      "currentTaxBps",
      [positive(id, "launch id")],
      blockNumber,
    );
    return safeNumber(scalar(result, "currentTaxBps"), "current tax", 10_000);
  }

  async spendReadiness(
    walletAddress: Address,
    requiredRaw: bigint,
    blockNumber: bigint,
  ): Promise<StonkSafeLaunchQuoteSpendReadiness> {
    const wallet = getAddress(walletAddress) as Address;
    const required = positive(requiredRaw, "required quote amount");
    const [balanceResult, allowanceResult] = await Promise.all([
      exactCall(
        this.#requester,
        this.profile.quoteAsset,
        erc20Interface,
        "balanceOf",
        [wallet],
        blockNumber,
      ),
      exactCall(
        this.#requester,
        this.profile.quoteAsset,
        erc20Interface,
        "allowance",
        [wallet, this.profile.factoryAddress],
        blockNumber,
      ),
    ]);
    const balanceRaw = uint(scalar(balanceResult, "balanceOf"), "quote balance");
    const allowanceRaw = uint(scalar(allowanceResult, "allowance"), "quote allowance");
    return Object.freeze({
      walletAddress: wallet,
      quoteAsset: this.profile.quoteAsset,
      factoryAddress: this.profile.factoryAddress,
      balanceRaw,
      allowanceRaw,
      requiredRaw: required,
      ready: balanceRaw >= required && allowanceRaw >= required,
    });
  }

  buildBuy(id: bigint, quoteIn: bigint, minTokensOut: bigint, ref: Hex): Hex {
    const validRef = hex32(ref, "buy ref");
    return quotedInterface.encodeFunctionData("buy", [
      positive(id, "launch id"),
      positive(quoteIn, "quote input"),
      positive(minTokensOut, "minimum output"),
      validRef,
    ]) as Hex;
  }
}

export class StonkSafeLaunchQuotedPoolRuntime implements PoolReadAdapter {
  readonly adapterId = STONK_SAFE_LAUNCH_QUOTED_ADAPTER_ID;
  readonly profileRevision: number;
  readonly launchId: bigint;
  readonly tokenAddress: Address;
  readonly #adapter: StonkSafeLaunchQuotedAdapter;
  readonly #armedBlock: bigint;
  readonly #requester: JsonRpcRequester;

  constructor(input: {
    readonly requester: JsonRpcRequester;
    readonly created: StonkSafeLaunchQuotedCreated;
    readonly armed: StonkSafeLaunchQuotedArmed;
    readonly profileRevision: number;
    readonly profile?: StonkSafeLaunchQuotedProfile;
  }) {
    const profile = input.profile ?? CLOCKIN_WETH_SAFE_LAUNCH_PROFILE;
    if (
      input.created.factoryAddress.toLowerCase() !== profile.factoryAddress.toLowerCase() ||
      input.armed.factoryAddress.toLowerCase() !== profile.factoryAddress.toLowerCase() ||
      input.created.id !== input.armed.id ||
      input.armed.blockNumber < input.created.blockNumber
    ) {
      throw new CanonicalInvariantError("IDENTITY_CONFLICT", "Created/Armed binding is invalid");
    }
    if (
      input.created.creatorAddress.toLowerCase() !== CLOCKIN_APPROVED_LAUNCH_CREATOR.toLowerCase()
    ) {
      throw new CanonicalInvariantError("IDENTITY_CONFLICT", "launch creator is not approved");
    }
    if (!Number.isSafeInteger(input.profileRevision) || input.profileRevision < 1) {
      throw new RangeError("profile revision must be positive");
    }
    this.#adapter = new StonkSafeLaunchQuotedAdapter(input.requester, profile);
    this.#requester = input.requester;
    this.profileRevision = input.profileRevision;
    this.launchId = input.created.id;
    this.tokenAddress = input.created.tokenAddress;
    this.#armedBlock = input.armed.blockNumber;
  }

  async readBlock(blockNumber: bigint): Promise<{
    readonly blockNumber: bigint;
    readonly blockHash: Hex;
    readonly blockTimestamp: bigint;
  }> {
    const block = await this.#requester.request<RpcBlock | null>("eth_getBlockByNumber", [
      quantityToHex(blockNumber),
      false,
    ]);
    if (block === null) throw new Error(`block ${blockNumber} is unavailable`);
    const observed = rpcQuantity(block.number, "block.number");
    if (observed !== blockNumber) throw new Error("RPC returned the wrong exact block");
    return Object.freeze({
      blockNumber: observed,
      blockHash: hex32(block.hash, "block.hash"),
      blockTimestamp: rpcQuantity(block.timestamp, "block.timestamp"),
    });
  }

  async readFeeBps(blockNumber: bigint): Promise<number> {
    return this.#adapter.currentTaxBps(this.launchId, blockNumber);
  }

  async readWindow(blockNumber: bigint): Promise<boolean> {
    const [state, block] = await Promise.all([
      this.#adapter.readLaunch(this.launchId, blockNumber),
      this.readBlock(blockNumber),
    ]);
    return (
      state.armed &&
      !state.graduated &&
      !state.bonded &&
      !state.aborted &&
      block.blockTimestamp < state.deadline
    );
  }

  async readCap(
    _blockNumber: bigint,
  ): Promise<{ readonly value: bigint; readonly scope: "NO_CAP" }> {
    return Object.freeze({
      value: STONK_SAFE_LAUNCH_QUOTED_BUY_LIMIT_POLICY.capRaw,
      scope: STONK_SAFE_LAUNCH_QUOTED_BUY_LIMIT_POLICY.capScope,
    });
  }

  async readCooldown(
    _blockNumber: bigint,
  ): Promise<{ readonly seconds: 0; readonly scope: "NONE" }> {
    return Object.freeze({
      seconds: STONK_SAFE_LAUNCH_QUOTED_BUY_LIMIT_POLICY.cooldownSeconds,
      scope: STONK_SAFE_LAUNCH_QUOTED_BUY_LIMIT_POLICY.cooldownScope,
    });
  }

  async readEoaOnly(blockNumber: bigint): Promise<boolean> {
    return blockNumber >= this.#armedBlock;
  }

  async readQuoteAsset(): Promise<Address> {
    return this.#adapter.profile.quoteAsset;
  }

  async readCurveStateHash(blockNumber: bigint): Promise<string> {
    const [state, block] = await Promise.all([
      this.#adapter.readLaunch(this.launchId, blockNumber),
      this.readBlock(blockNumber),
    ]);
    return stableHash({
      adapterId: this.adapterId,
      factoryAddress: this.#adapter.profile.factoryAddress,
      launchId: this.launchId.toString(),
      blockNumber: block.blockNumber.toString(),
      blockHash: block.blockHash,
      virtualQuote: state.virtualQuote.toString(),
      virtualToken: state.virtualToken.toString(),
      realQuote: state.realQuote.toString(),
      buyCount: state.buyCount.toString(),
    });
  }

  observe(blockNumber: bigint, evidenceIds: readonly string[]): Promise<PoolObservation> {
    return observePoolAt(this, this.profileRevision, blockNumber, evidenceIds);
  }

  async previewBuyRaw(principalRaw: bigint, blockNumber: bigint): Promise<bigint> {
    return (await this.#adapter.quoteBuy(this.launchId, principalRaw, blockNumber)).tokensOut;
  }

  buildEntryBuy(input: {
    readonly walletAddress: Address;
    readonly principalRaw: bigint;
    readonly minOutputRaw: bigint;
    readonly earliestValidBlock: bigint;
  }): EntryTransactionTemplate {
    return Object.freeze({
      adapterId: this.adapterId,
      profileRevision: this.profileRevision,
      walletAddress: getAddress(input.walletAddress) as Address,
      target: this.#adapter.profile.factoryAddress,
      valueRaw: 0n,
      calldata: this.#adapter.buildBuy(
        this.launchId,
        input.principalRaw,
        input.minOutputRaw,
        `0x${"00".repeat(32)}`,
      ),
      minOutputRaw: input.minOutputRaw,
      earliestValidBlock: input.earliestValidBlock,
      expectedEffectAssets: Object.freeze([this.tokenAddress]),
    });
  }

  spendReadiness(
    walletAddress: Address,
    requiredRaw: bigint,
    blockNumber: bigint,
  ): Promise<StonkSafeLaunchQuoteSpendReadiness> {
    return this.#adapter.spendReadiness(walletAddress, requiredRaw, blockNumber);
  }
}
