import { getAddress, Interface, isHexString, MaxUint256, ZeroAddress } from "ethers";

import { CanonicalInvariantError } from "../core/canonical.js";
import { quantityToHex } from "../rpc/hex.js";
import type { Hex, JsonRpcRequester } from "../rpc/types.js";
import type { RpcContractLog } from "../rpc/websocket-logs.js";

export const STONK_SAFE_LAUNCH_ADAPTER_ID = "stonk.safe-launch-mainnet-v1";
export const STONK_SAFE_LAUNCH_FACTORY_ADDRESS =
  "0xEcA5726dae1e53365c37fFc02369d947A91d71f9" as const;
export const STONK_SAFE_LAUNCH_FACTORY_RUNTIME_CODE_HASH =
  "0xea44430fca3e9fe18dd54972bcf0a843e3582a6a740027b7fa49e5631809175d" as const;

export const STONK_SAFE_LAUNCH_CREATED_EVENT_ABI =
  "event LaunchCreated(uint256 indexed id,address indexed token,address indexed creator,bool externalToken,address[] legs)";
export const STONK_SAFE_LAUNCH_ARMED_EVENT_ABI =
  "event LaunchArmed(uint256 indexed id,uint256 supply,uint256 vEth0,uint64 ethUsd8,uint64 deadline)";
export const STONK_SAFE_LAUNCH_QUOTE_BUY_ABI =
  "function quoteBuy(uint256 id,uint256 ethIn) view returns (uint256 tokensOut,uint256 taxBps)";
export const STONK_SAFE_LAUNCH_CURRENT_TAX_ABI =
  "function currentTaxBps(uint256 id) view returns (uint256)";
export const STONK_SAFE_LAUNCH_BUY_ABI =
  "function buy(uint256 id,uint256 minTokensOut,bytes32 ref) payable returns (uint256 tokensOut)";

export const STONK_SAFE_LAUNCH_ABI = Object.freeze([
  STONK_SAFE_LAUNCH_CREATED_EVENT_ABI,
  STONK_SAFE_LAUNCH_ARMED_EVENT_ABI,
  STONK_SAFE_LAUNCH_QUOTE_BUY_ABI,
  STONK_SAFE_LAUNCH_CURRENT_TAX_ABI,
  STONK_SAFE_LAUNCH_BUY_ABI,
]);

const factoryInterface = new Interface(STONK_SAFE_LAUNCH_ABI);
const launchCreatedEvent = factoryInterface.getEvent("LaunchCreated");
const launchArmedEvent = factoryInterface.getEvent("LaunchArmed");
if (launchCreatedEvent === null || launchArmedEvent === null) {
  throw new Error("Stonk Safe Launch event ABI is unavailable");
}

export const STONK_SAFE_LAUNCH_CREATED_TOPIC = launchCreatedEvent.topicHash as Hex;
export const STONK_SAFE_LAUNCH_ARMED_TOPIC = launchArmedEvent.topicHash as Hex;

interface StonkSafeLaunchEventRef {
  readonly factoryAddress: typeof STONK_SAFE_LAUNCH_FACTORY_ADDRESS;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: bigint;
}

export interface StonkSafeLaunchCreated extends StonkSafeLaunchEventRef {
  readonly kind: "LaunchCreated";
  readonly id: bigint;
  readonly tokenAddress: Hex;
  readonly creatorAddress: Hex;
  readonly externalToken: boolean;
  readonly legs: readonly Hex[];
}

export interface StonkSafeLaunchArmed extends StonkSafeLaunchEventRef {
  readonly kind: "LaunchArmed";
  readonly id: bigint;
  readonly supply: bigint;
  readonly virtualEthInitial: bigint;
  readonly ethUsd8: bigint;
  readonly deadline: bigint;
}

export type StonkSafeLaunchEvent = StonkSafeLaunchCreated | StonkSafeLaunchArmed;

export interface StonkSafeLaunchBuyQuote {
  readonly id: bigint;
  readonly ethIn: bigint;
  readonly tokensOut: bigint;
  readonly taxBps: number;
  readonly blockNumber: bigint;
}

export interface StonkSafeLaunchBuyTemplate {
  readonly adapterId: typeof STONK_SAFE_LAUNCH_ADAPTER_ID;
  readonly target: typeof STONK_SAFE_LAUNCH_FACTORY_ADDRESS;
  readonly launchId: bigint;
  readonly minTokensOut: bigint;
  readonly ref: Hex;
  readonly calldata: Hex;
  readonly payable: true;
}

function uint256(value: unknown, label: string): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(String(value));
  } catch (error) {
    throw new TypeError(`${label} is not an integer`, { cause: error });
  }
  if (parsed < 0n || parsed > MaxUint256) throw new RangeError(`${label} is not uint256`);
  return parsed;
}

function launchId(value: unknown): bigint {
  const parsed = uint256(value, "launch id");
  if (parsed === 0n) throw new RangeError("launch id must be positive");
  return parsed;
}

function positiveUint(value: unknown, label: string): bigint {
  const parsed = uint256(value, label);
  if (parsed === 0n) throw new RangeError(`${label} must be positive`);
  return parsed;
}

function taxBps(value: unknown, label: string): number {
  const parsed = uint256(value, label);
  if (parsed > 10_000n) throw new RangeError(`${label} exceeds 10000`);
  return Number(parsed);
}

function bytes32(value: Hex, label: string): Hex {
  if (!isHexString(value, 32)) throw new TypeError(`${label} must be bytes32`);
  return value;
}

function nonZeroAddress(value: unknown, label: string): Hex {
  const parsed = getAddress(String(value)) as Hex;
  if (parsed.toLowerCase() === ZeroAddress.toLowerCase()) {
    throw new Error(`${label} must not be the zero address`);
  }
  return parsed;
}

function parseBoundEvent(
  log: RpcContractLog,
  eventName: "LaunchCreated" | "LaunchArmed",
  expectedTopic: Hex,
  expectedTopicCount: number,
): NonNullable<ReturnType<Interface["parseLog"]>> {
  if (log.removed) {
    throw new CanonicalInvariantError(
      "REORG_DETECTED",
      `removed ${eventName} log is not canonical`,
    );
  }
  if (log.address.toLowerCase() !== STONK_SAFE_LAUNCH_FACTORY_ADDRESS.toLowerCase()) {
    throw new CanonicalInvariantError(
      "IDENTITY_CONFLICT",
      `${eventName} emitter is not the verified Stonk Safe Launch Factory`,
    );
  }
  if (
    log.topics.length !== expectedTopicCount ||
    log.topics[0]?.toLowerCase() !== expectedTopic.toLowerCase()
  ) {
    throw new CanonicalInvariantError(
      "IDENTITY_CONFLICT",
      `${eventName} topic does not match the verified ABI`,
    );
  }
  let parsed: ReturnType<Interface["parseLog"]>;
  try {
    parsed = factoryInterface.parseLog({ topics: [...log.topics], data: log.data });
  } catch (error) {
    throw new Error(`${eventName} log does not decode under the verified ABI`, { cause: error });
  }
  if (parsed === null || parsed.name !== eventName) {
    throw new Error(`decoded log is not ${eventName}`);
  }
  return parsed;
}

function eventRef(log: RpcContractLog): StonkSafeLaunchEventRef {
  return Object.freeze({
    factoryAddress: STONK_SAFE_LAUNCH_FACTORY_ADDRESS,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
  });
}

export function decodeStonkSafeLaunchCreated(log: RpcContractLog): StonkSafeLaunchCreated {
  const parsed = parseBoundEvent(log, "LaunchCreated", STONK_SAFE_LAUNCH_CREATED_TOPIC, 4);
  const id = launchId(parsed.args.id);
  const tokenAddress = nonZeroAddress(parsed.args.token, "LaunchCreated token");
  const creatorAddress = nonZeroAddress(parsed.args.creator, "LaunchCreated creator");
  if (typeof parsed.args.externalToken !== "boolean") {
    throw new TypeError("LaunchCreated externalToken is not boolean");
  }
  if (!Array.isArray(parsed.args.legs) || parsed.args.legs.length === 0) {
    throw new Error("LaunchCreated legs must not be empty");
  }
  const legs = Object.freeze(
    parsed.args.legs.map((leg: unknown) => getAddress(String(leg)) as Hex),
  );
  if (new Set(legs.map((leg) => leg.toLowerCase())).size !== legs.length) {
    throw new Error("LaunchCreated legs must be unique");
  }
  if (legs.some((leg) => leg.toLowerCase() === tokenAddress.toLowerCase())) {
    throw new Error("LaunchCreated token cannot also be a quote leg");
  }
  return Object.freeze({
    ...eventRef(log),
    kind: "LaunchCreated",
    id,
    tokenAddress,
    creatorAddress,
    externalToken: parsed.args.externalToken,
    legs,
  });
}

export function decodeStonkSafeLaunchArmed(log: RpcContractLog): StonkSafeLaunchArmed {
  const parsed = parseBoundEvent(log, "LaunchArmed", STONK_SAFE_LAUNCH_ARMED_TOPIC, 2);
  return Object.freeze({
    ...eventRef(log),
    kind: "LaunchArmed",
    id: launchId(parsed.args.id),
    supply: positiveUint(parsed.args.supply, "LaunchArmed supply"),
    virtualEthInitial: positiveUint(parsed.args.vEth0, "LaunchArmed vEth0"),
    ethUsd8: positiveUint(parsed.args.ethUsd8, "LaunchArmed ethUsd8"),
    deadline: positiveUint(parsed.args.deadline, "LaunchArmed deadline"),
  });
}

export function decodeStonkSafeLaunchEvent(log: RpcContractLog): StonkSafeLaunchEvent {
  const topic = log.topics[0]?.toLowerCase();
  if (topic === STONK_SAFE_LAUNCH_CREATED_TOPIC.toLowerCase()) {
    return decodeStonkSafeLaunchCreated(log);
  }
  if (topic === STONK_SAFE_LAUNCH_ARMED_TOPIC.toLowerCase()) {
    return decodeStonkSafeLaunchArmed(log);
  }
  throw new CanonicalInvariantError(
    "IDENTITY_CONFLICT",
    "log topic is not a verified Stonk Safe Launch event",
  );
}

async function exactCall(
  requester: JsonRpcRequester,
  functionName: "quoteBuy" | "currentTaxBps",
  args: readonly unknown[],
  blockNumber: bigint,
): Promise<readonly unknown[]> {
  if (blockNumber < 0n) throw new RangeError("exact block number must not be negative");
  const data = factoryInterface.encodeFunctionData(functionName, [...args]);
  const raw = await requester.request<string>("eth_call", [
    { to: STONK_SAFE_LAUNCH_FACTORY_ADDRESS, data },
    quantityToHex(blockNumber),
  ]);
  if (!isHexString(raw)) throw new TypeError(`${functionName} returned invalid ABI data`);
  try {
    return factoryInterface.decodeFunctionResult(functionName, raw);
  } catch (error) {
    throw new Error(`${functionName} result does not decode under the verified ABI`, {
      cause: error,
    });
  }
}

export class StonkSafeLaunchAdapter {
  readonly adapterId = STONK_SAFE_LAUNCH_ADAPTER_ID;
  readonly factoryAddress = STONK_SAFE_LAUNCH_FACTORY_ADDRESS;
  readonly factoryRuntimeCodeHash = STONK_SAFE_LAUNCH_FACTORY_RUNTIME_CODE_HASH;
  readonly #requester: JsonRpcRequester;

  constructor(requester: JsonRpcRequester) {
    this.#requester = requester;
  }

  async quoteBuy(id: bigint, ethIn: bigint, blockNumber: bigint): Promise<StonkSafeLaunchBuyQuote> {
    const validId = launchId(id);
    const validEthIn = positiveUint(ethIn, "quoteBuy ethIn");
    const result = await exactCall(this.#requester, "quoteBuy", [validId, validEthIn], blockNumber);
    if (result.length !== 2) throw new Error("quoteBuy must return exactly two ABI values");
    const tokensOut = positiveUint(result[0], "quoteBuy tokensOut");
    return Object.freeze({
      id: validId,
      ethIn: validEthIn,
      tokensOut,
      taxBps: taxBps(result[1], "quoteBuy taxBps"),
      blockNumber,
    });
  }

  async currentTaxBps(id: bigint, blockNumber: bigint): Promise<number> {
    const result = await exactCall(this.#requester, "currentTaxBps", [launchId(id)], blockNumber);
    if (result.length !== 1) throw new Error("currentTaxBps must return exactly one ABI value");
    return taxBps(result[0], "currentTaxBps");
  }

  buildBuy(id: bigint, minTokensOut: bigint, ref: Hex): StonkSafeLaunchBuyTemplate {
    const validId = launchId(id);
    const validMinimum = positiveUint(minTokensOut, "buy minTokensOut");
    const validRef = bytes32(ref, "buy ref");
    return Object.freeze({
      adapterId: STONK_SAFE_LAUNCH_ADAPTER_ID,
      target: STONK_SAFE_LAUNCH_FACTORY_ADDRESS,
      launchId: validId,
      minTokensOut: validMinimum,
      ref: validRef,
      calldata: factoryInterface.encodeFunctionData("buy", [
        validId,
        validMinimum,
        validRef,
      ]) as Hex,
      payable: true,
    });
  }
}
