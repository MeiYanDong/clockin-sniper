import { Interface, ZeroAddress, getAddress, keccak256 } from "ethers";

import { assertAddress, assertHex, quantityToHex } from "./rpc/hex.js";
import type { RpcContractLog } from "./rpc/websocket-logs.js";
import type { Hex, JsonRpcRequester } from "./rpc/types.js";

const FACTORY_ABI = [
  "event TokenLaunched(address indexed creator,address indexed memeToken,address indexed pool,string name,string symbol,string metadataURI,bytes32 imageHash)",
] as const;

const POOL_ABI = [
  "function buy(uint256 minTokensOut, bytes32 refCode) payable returns (uint256 tokensOut)",
  "function currentFeeBps() view returns (uint16)",
  "function inSniperWindow() view returns (bool)",
  "function windowMaxBuyBps() view returns (uint16)",
  "function currentWindowCap() view returns (uint256)",
  "function buyCooldownSecs() view returns (uint32)",
  "function eoaOnlySecs() view returns (uint32)",
  "function quoteAsset() view returns (address)",
] as const;

const factoryInterface = new Interface(FACTORY_ABI);
const poolInterface = new Interface(POOL_ABI);
const tokenLaunchedEvent = factoryInterface.getEvent("TokenLaunched");
if (tokenLaunchedEvent === null) throw new Error("TokenLaunched ABI is unavailable");

export const TOKEN_LAUNCHED_TOPIC = tokenLaunchedEvent.topicHash as Hex;
export const CURRENT_FEE_CALL_DATA = poolInterface.encodeFunctionData("currentFeeBps") as Hex;

export interface StonkLaunchCandidate {
  readonly factoryAddress: Hex;
  readonly creator: Hex;
  readonly tokenAddress: Hex;
  readonly poolAddress: Hex;
  readonly name: string;
  readonly symbol: string;
  readonly metadataUri: string;
  readonly imageHash: Hex;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: bigint;
  readonly source: "wss" | "backfill";
}

export interface LaunchIdentityPolicy {
  readonly factoryAddress: Hex;
  readonly expectedName: string;
  readonly expectedSymbol: string;
  readonly expectedCreator?: Hex;
  readonly metadataIncludes?: string;
  readonly requiredTokenSuffix?: string;
}

export interface IdentityEvaluation {
  readonly accepted: boolean;
  readonly reasons: readonly string[];
}

export interface StonkPoolSnapshot {
  readonly observedBlockNumber: bigint;
  readonly currentFeeBps: number;
  readonly inSniperWindow: boolean;
  readonly windowMaxBuyBps: number;
  readonly currentWindowCap: bigint;
  readonly buyCooldownSecs: number;
  readonly eoaOnlySecs: number;
  readonly quoteAsset: Hex;
}

function normalizedIdentityText(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[\s_-]+/g, "");
}

export function decodeTokenLaunchedLog(
  log: RpcContractLog,
  source: StonkLaunchCandidate["source"] = "wss",
): StonkLaunchCandidate {
  if (log.removed) throw new Error("cannot freeze a removed TokenLaunched log");
  let parsed: ReturnType<Interface["parseLog"]>;
  try {
    parsed = factoryInterface.parseLog({ topics: [...log.topics], data: log.data });
  } catch (error) {
    throw new Error("log does not decode as the bound TokenLaunched event", { cause: error });
  }
  if (parsed === null || parsed.name !== "TokenLaunched") {
    throw new Error("log is not TokenLaunched");
  }
  const creator = getAddress(String(parsed.args.creator)) as Hex;
  const tokenAddress = getAddress(String(parsed.args.memeToken)) as Hex;
  const poolAddress = getAddress(String(parsed.args.pool)) as Hex;
  const imageHash = String(parsed.args.imageHash);
  assertHex("TokenLaunched.imageHash", imageHash);
  if (imageHash.length !== 66) throw new Error("TokenLaunched.imageHash is not bytes32");

  return Object.freeze({
    factoryAddress: getAddress(log.address) as Hex,
    creator,
    tokenAddress,
    poolAddress,
    name: String(parsed.args.name),
    symbol: String(parsed.args.symbol),
    metadataUri: String(parsed.args.metadataURI),
    imageHash: imageHash as Hex,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    source,
  });
}

export function evaluateLaunchIdentity(
  candidate: StonkLaunchCandidate,
  policy: LaunchIdentityPolicy,
): IdentityEvaluation {
  const reasons: string[] = [];
  if (candidate.factoryAddress.toLowerCase() !== policy.factoryAddress.toLowerCase()) {
    reasons.push("factory_mismatch");
  }
  if (normalizedIdentityText(candidate.name) !== normalizedIdentityText(policy.expectedName)) {
    reasons.push("name_mismatch");
  }
  if (normalizedIdentityText(candidate.symbol) !== normalizedIdentityText(policy.expectedSymbol)) {
    reasons.push("symbol_mismatch");
  }
  if (
    policy.expectedCreator !== undefined &&
    candidate.creator.toLowerCase() !== policy.expectedCreator.toLowerCase()
  ) {
    reasons.push("creator_mismatch");
  }
  if (
    policy.metadataIncludes !== undefined &&
    !candidate.metadataUri.toLowerCase().includes(policy.metadataIncludes.toLowerCase())
  ) {
    reasons.push("metadata_mismatch");
  }
  if (
    policy.requiredTokenSuffix !== undefined &&
    !candidate.tokenAddress.toLowerCase().endsWith(policy.requiredTokenSuffix.toLowerCase())
  ) {
    reasons.push("token_suffix_mismatch");
  }
  return Object.freeze({ accepted: reasons.length === 0, reasons: Object.freeze(reasons) });
}

export function buildNativeBuyCallData(minTokensOut: bigint, refCode: Hex): Hex {
  if (minTokensOut < 0n) throw new RangeError("minTokensOut must not be negative");
  assertHex("refCode", refCode);
  if (refCode.length !== 66) throw new RangeError("refCode must be bytes32");
  return poolInterface.encodeFunctionData("buy", [minTokensOut, refCode]) as Hex;
}

async function readPoolValue(
  requester: JsonRpcRequester,
  poolAddress: Hex,
  functionName: string,
  blockTag: Hex,
): Promise<readonly unknown[]> {
  const data = poolInterface.encodeFunctionData(functionName);
  const result = await requester.request<string>("eth_call", [{ to: poolAddress, data }, blockTag]);
  assertHex(`${functionName} result`, result);
  return poolInterface.decodeFunctionResult(functionName, result);
}

function safeNumber(name: string, value: unknown): number {
  const integer = BigInt(String(value));
  if (integer < 0n || integer > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${name} does not fit a safe integer`);
  }
  return Number(integer);
}

export async function readStonkPoolSnapshot(
  requester: JsonRpcRequester,
  poolAddress: Hex,
  blockNumber: bigint,
): Promise<StonkPoolSnapshot> {
  assertAddress("poolAddress", poolAddress);
  if (blockNumber < 0n) throw new RangeError("blockNumber must not be negative");
  const blockTag = quantityToHex(blockNumber);
  const [fee, sniper, maxBuy, cap, cooldown, eoaOnly, quote] = await Promise.all([
    readPoolValue(requester, poolAddress, "currentFeeBps", blockTag),
    readPoolValue(requester, poolAddress, "inSniperWindow", blockTag),
    readPoolValue(requester, poolAddress, "windowMaxBuyBps", blockTag),
    readPoolValue(requester, poolAddress, "currentWindowCap", blockTag),
    readPoolValue(requester, poolAddress, "buyCooldownSecs", blockTag),
    readPoolValue(requester, poolAddress, "eoaOnlySecs", blockTag),
    readPoolValue(requester, poolAddress, "quoteAsset", blockTag),
  ]);
  const currentFeeBps = safeNumber("currentFeeBps", fee[0]);
  if (currentFeeBps > 10_000) throw new RangeError("currentFeeBps exceeds 10000");
  const quoteAsset = getAddress(String(quote[0])) as Hex;

  return Object.freeze({
    observedBlockNumber: blockNumber,
    currentFeeBps,
    inSniperWindow: Boolean(sniper[0]),
    windowMaxBuyBps: safeNumber("windowMaxBuyBps", maxBuy[0]),
    currentWindowCap: BigInt(String(cap[0])),
    buyCooldownSecs: safeNumber("buyCooldownSecs", cooldown[0]),
    eoaOnlySecs: safeNumber("eoaOnlySecs", eoaOnly[0]),
    quoteAsset,
  });
}

export function assertNativeQuotePool(snapshot: StonkPoolSnapshot): void {
  if (snapshot.quoteAsset.toLowerCase() !== ZeroAddress.toLowerCase()) {
    throw new Error("discovered pool is not native-ETH quoted; buyWithQuote is unsupported");
  }
}

export function runtimeCodeHash(code: string): Hex {
  assertHex("runtime code", code);
  if (code === "0x" || code === "0x0") throw new Error("contract runtime code is empty");
  return keccak256(code) as Hex;
}
