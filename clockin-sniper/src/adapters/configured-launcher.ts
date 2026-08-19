import { FunctionFragment, Interface, getAddress, isHexString, keccak256 } from "ethers";

import {
  CanonicalInvariantError,
  stableHash,
  type Address,
  type LaunchCandidate,
  type LaunchIdentity,
} from "../core/canonical.js";
import type { LaunchCodeIdentityTier } from "../entry/bounded-canary-policy.js";
import type { ExactBlockRef, PoolObservation, PoolReadAdapter } from "../entry/pool-observation.js";
import { observePoolAt } from "../entry/pool-observation.js";
import { quantityToHex } from "../rpc/hex.js";
import type { RpcContractLog } from "../rpc/websocket-logs.js";
import type { Hex, JsonRpcRequester } from "../rpc/types.js";
import type { ProductionProtocolProfile } from "../runtime/production-profile.js";
import type { EntryTransactionTemplate } from "./protocol-contracts.js";

interface RpcBlock {
  readonly number?: unknown;
  readonly hash?: unknown;
  readonly timestamp?: unknown;
  readonly stateRoot?: unknown;
}

interface BoundFunction {
  readonly abi: string;
  readonly fragment: FunctionFragment;
  readonly contract: Interface;
}

function blockQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u.test(value)) {
    throw new TypeError(`${label} is not a canonical RPC quantity`);
  }
  return BigInt(value);
}

function hex32(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !isHexString(value, 32)) {
    throw new TypeError(`${label} is not a 32-byte hex value`);
  }
  return value as `0x${string}`;
}

function bindFunction(abi: string): BoundFunction {
  const fragment = FunctionFragment.from(abi);
  return Object.freeze({ abi, fragment, contract: new Interface([fragment]) });
}

function scalar(result: readonly unknown[], label: string): unknown {
  if (result.length !== 1) throw new Error(`${label} must return exactly one ABI value`);
  return result[0];
}

function safeInteger(value: unknown, label: string): number {
  const parsed = BigInt(String(value));
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} does not fit a non-negative safe integer`);
  }
  return Number(parsed);
}

async function readBlock(requester: JsonRpcRequester, blockNumber: bigint): Promise<RpcBlock> {
  const block = await requester.request<RpcBlock | null>("eth_getBlockByNumber", [
    quantityToHex(blockNumber),
    false,
  ]);
  if (block === null) throw new Error(`block ${blockNumber} is unavailable`);
  return block;
}

export function decodeConfiguredLaunchLog(input: {
  readonly log: RpcContractLog;
  readonly profile: ProductionProtocolProfile;
  readonly blockHash: `0x${string}`;
  readonly transactionIndex: bigint;
  readonly observedAt: string;
  readonly evidenceIds: readonly string[];
}): LaunchCandidate {
  if (input.log.removed) {
    throw new CanonicalInvariantError("REORG_DETECTED", "removed launch logs cannot be frozen");
  }
  if (input.log.address.toLowerCase() !== input.profile.factory.address.toLowerCase()) {
    throw new CanonicalInvariantError(
      "IDENTITY_CONFLICT",
      "launch log emitter is not the frozen Factory",
    );
  }
  if (input.log.topics[0]?.toLowerCase() !== input.profile.factory.launchEventTopic.toLowerCase()) {
    throw new CanonicalInvariantError(
      "IDENTITY_CONFLICT",
      "launch log topic is not the frozen event",
    );
  }
  const contract = new Interface([input.profile.factory.launchEventAbi]);
  const parsed = contract.parseLog({ topics: [...input.log.topics], data: input.log.data });
  if (parsed === null) throw new Error("launch log did not decode under the frozen ABI");
  const fields = input.profile.factory.launchFields;
  const creator = getAddress(String(parsed.args[fields.creator])) as Address;
  const tokenAddress = getAddress(String(parsed.args[fields.token])) as Address;
  const poolAddress = getAddress(String(parsed.args[fields.pool])) as Address;
  const imageHash = hex32(parsed.args[fields.imageHash], "launch imageHash");
  const base = {
    factoryProfileId: input.profile.profileId,
    transactionHash: input.log.transactionHash,
    logIndex: input.log.logIndex.toString(),
    tokenAddress,
    poolAddress,
  };
  return Object.freeze({
    candidateId: `candidate:${stableHash(base)}`,
    strategyId: "clockin-mainnet-v1",
    revision: 1,
    factoryProfileId: input.profile.profileId,
    creator,
    tokenAddress,
    poolAddress,
    name: String(parsed.args[fields.name]),
    symbol: String(parsed.args[fields.symbol]),
    metadataUri: String(parsed.args[fields.metadataUri]),
    imageHash,
    blockNumber: input.log.blockNumber.toString(),
    blockHash: input.blockHash,
    transactionHash: input.log.transactionHash,
    transactionIndex: input.transactionIndex.toString(),
    logIndex: input.log.logIndex.toString(),
    evidenceIds: Object.freeze([...input.evidenceIds]),
    observedAt: input.observedAt,
  });
}

export class ConfiguredLauncherPoolRuntime implements PoolReadAdapter {
  readonly adapterId = "clockin.configured-launcher-native-v1";
  readonly #requester: JsonRpcRequester;
  readonly #profile: ProductionProtocolProfile;
  readonly #identity: LaunchIdentity;
  readonly #functions: Readonly<
    Record<keyof ProductionProtocolProfile["mechanism"]["functions"], BoundFunction>
  >;
  #launchTimestamp: bigint | null = null;

  constructor(input: {
    readonly requester: JsonRpcRequester;
    readonly profile: ProductionProtocolProfile;
    readonly identity: LaunchIdentity;
    readonly requiredCodeIdentityTier?: LaunchCodeIdentityTier;
  }) {
    if (
      input.identity.state !== "FROZEN" ||
      input.identity.factoryProfileId !== input.profile.profileId ||
      input.identity.mechanismProfileId !== input.profile.mechanism.profileId
    ) {
      throw new CanonicalInvariantError("PROFILE_STALE", "identity and production profile differ");
    }
    const codeIdentityTier = input.requiredCodeIdentityTier ?? "PROFILE_ALLOWLISTED";
    if (
      codeIdentityTier === "PROFILE_ALLOWLISTED" &&
      (!input.profile.mechanism.tokenRuntimeCodeHashes.some(
        (hash) => hash.toLowerCase() === input.identity.tokenRuntimeCodeHash.toLowerCase(),
      ) ||
        !input.profile.mechanism.poolRuntimeCodeHashes.some(
          (hash) => hash.toLowerCase() === input.identity.poolRuntimeCodeHash.toLowerCase(),
        ))
    ) {
      throw new CanonicalInvariantError(
        "PROFILE_UNSUPPORTED",
        "identity code hashes are not allowlisted by the production profile",
      );
    }
    this.#requester = input.requester;
    this.#profile = input.profile;
    this.#identity = input.identity;
    const functions = input.profile.mechanism.functions;
    this.#functions = Object.freeze({
      currentFee: bindFunction(functions.currentFee),
      inWindow: bindFunction(functions.inWindow),
      currentCap: bindFunction(functions.currentCap),
      buyCooldown: bindFunction(functions.buyCooldown),
      eoaOnly: bindFunction(functions.eoaOnly),
      quoteAsset: bindFunction(functions.quoteAsset),
      previewBuy: bindFunction(functions.previewBuy),
      buy: bindFunction(functions.buy),
    });
  }

  async readBlock(blockNumber: bigint): Promise<ExactBlockRef> {
    const block = await readBlock(this.#requester, blockNumber);
    const observedNumber = blockQuantity(block.number, "block.number");
    if (observedNumber !== blockNumber) throw new Error("RPC returned the wrong exact block");
    return Object.freeze({
      blockNumber,
      blockHash: hex32(block.hash, "block.hash"),
      blockTimestamp: blockQuantity(block.timestamp, "block.timestamp"),
    });
  }

  async readFeeBps(blockNumber: bigint): Promise<number> {
    return safeInteger(
      await this.#callScalar(this.#functions.currentFee, [], blockNumber),
      "currentFee",
    );
  }

  async readWindow(blockNumber: bigint): Promise<boolean> {
    const value = await this.#callScalar(this.#functions.inWindow, [], blockNumber);
    if (typeof value !== "boolean") throw new TypeError("inWindow did not return a boolean");
    return value;
  }

  async readCap(blockNumber: bigint): Promise<{
    value: bigint;
    scope: ProductionProtocolProfile["mechanism"]["capScope"];
  }> {
    const value = BigInt(
      String(await this.#callScalar(this.#functions.currentCap, [], blockNumber)),
    );
    return Object.freeze({ value, scope: this.#profile.mechanism.capScope });
  }

  async readCooldown(blockNumber: bigint): Promise<{
    seconds: number;
    scope: ProductionProtocolProfile["mechanism"]["cooldownScope"];
  }> {
    const seconds = safeInteger(
      await this.#callScalar(this.#functions.buyCooldown, [], blockNumber),
      "buyCooldown",
    );
    return Object.freeze({ seconds, scope: this.#profile.mechanism.cooldownScope });
  }

  async readEoaOnly(blockNumber: bigint): Promise<boolean> {
    const [seconds, block] = await Promise.all([
      this.#callScalar(this.#functions.eoaOnly, [], blockNumber),
      this.readBlock(blockNumber),
    ]);
    if (this.#launchTimestamp === null) {
      const launchBlock = await this.readBlock(BigInt(this.#identity.blockNumber));
      this.#launchTimestamp = launchBlock.blockTimestamp;
    }
    return block.blockTimestamp < this.#launchTimestamp + BigInt(String(seconds));
  }

  async readQuoteAsset(blockNumber: bigint): Promise<`0x${string}`> {
    return getAddress(
      String(await this.#callScalar(this.#functions.quoteAsset, [], blockNumber)),
    ) as Address;
  }

  async readCurveStateHash(blockNumber: bigint): Promise<string> {
    const block = await readBlock(this.#requester, blockNumber);
    return stableHash({
      poolAddress: this.#identity.poolAddress,
      blockNumber: blockNumber.toString(),
      blockHash: hex32(block.hash, "block.hash"),
      stateRoot: hex32(block.stateRoot, "block.stateRoot"),
    });
  }

  async observe(blockNumber: bigint, evidenceIds: readonly string[]): Promise<PoolObservation> {
    return observePoolAt(this, this.#profile.mechanism.revision, blockNumber, evidenceIds);
  }

  async previewBuyRaw(principalRaw: bigint, blockNumber: bigint): Promise<bigint> {
    if (principalRaw <= 0n) throw new RangeError("buy principal must be positive");
    const value = await this.#callScalar(this.#functions.previewBuy, [principalRaw], blockNumber);
    const output = BigInt(String(value));
    if (output <= 0n) throw new Error("previewBuy returned no executable token output");
    return output;
  }

  buildNativeBuy(input: {
    readonly walletAddress: Address;
    readonly principalRaw: bigint;
    readonly minOutputRaw: bigint;
    readonly earliestValidBlock: bigint;
  }): EntryTransactionTemplate {
    if (input.principalRaw <= 0n || input.minOutputRaw <= 0n) {
      throw new RangeError("buy principal and minOut must be positive");
    }
    const calldata = this.#functions.buy.contract.encodeFunctionData(this.#functions.buy.fragment, [
      input.minOutputRaw,
      this.#profile.entry.refCode,
    ]) as Hex;
    return Object.freeze({
      adapterId: this.adapterId,
      profileRevision: this.#profile.mechanism.revision,
      walletAddress: input.walletAddress,
      target: this.#identity.poolAddress,
      valueRaw: input.principalRaw,
      calldata,
      minOutputRaw: input.minOutputRaw,
      earliestValidBlock: input.earliestValidBlock,
      expectedEffectAssets: Object.freeze([this.#identity.tokenAddress]),
    });
  }

  async #callScalar(
    fn: BoundFunction,
    args: readonly unknown[],
    blockNumber: bigint,
  ): Promise<unknown> {
    const data = fn.contract.encodeFunctionData(fn.fragment, [...args]);
    const raw = await this.#requester.request<string>("eth_call", [
      { to: this.#identity.poolAddress, data },
      quantityToHex(blockNumber),
    ]);
    if (!isHexString(raw)) throw new TypeError(`${fn.fragment.name} returned invalid ABI data`);
    return scalar(fn.contract.decodeFunctionResult(fn.fragment, raw), fn.fragment.name);
  }
}

export async function verifyConfiguredCodeIdentity(input: {
  readonly requester: JsonRpcRequester;
  readonly profile: ProductionProtocolProfile;
  readonly blockNumber: bigint | "latest";
  readonly identity?: LaunchIdentity;
  readonly requiredCodeIdentityTier?: LaunchCodeIdentityTier;
}): Promise<
  Readonly<{
    factoryCodeHash: Hex;
    tokenCodeHash?: Hex;
    poolCodeHash?: Hex;
    codeIdentityTier?: LaunchCodeIdentityTier;
  }>
> {
  const blockTag = input.blockNumber === "latest" ? "latest" : quantityToHex(input.blockNumber);
  const targets = [input.profile.factory.address];
  if (input.identity !== undefined)
    targets.push(input.identity.tokenAddress, input.identity.poolAddress);
  const codes = await Promise.all(
    targets.map((target) => input.requester.request<string>("eth_getCode", [target, blockTag])),
  );
  const hashes = codes.map((code, index) => {
    if (!isHexString(code) || code === "0x")
      throw new Error(`contract ${index + 1} has empty code`);
    return keccak256(code) as Hex;
  });
  const factoryCodeHash = hashes[0] as Hex;
  if (factoryCodeHash.toLowerCase() !== input.profile.factory.runtimeCodeHash.toLowerCase()) {
    throw new CanonicalInvariantError("FACTORY_CODE_DRIFT", "Factory runtime code hash drifted");
  }
  if (input.profile.factory.implementationAddress !== undefined) {
    const implementationCode = await input.requester.request<string>("eth_getCode", [
      input.profile.factory.implementationAddress,
      blockTag,
    ]);
    const implementationHash = keccak256(implementationCode);
    if (
      implementationHash.toLowerCase() !==
      input.profile.factory.implementationCodeHash?.toLowerCase()
    ) {
      throw new CanonicalInvariantError(
        "FACTORY_CODE_DRIFT",
        "Factory implementation code hash drifted",
      );
    }
  }
  if (input.identity === undefined) return Object.freeze({ factoryCodeHash });
  const tokenCodeHash = hashes[1] as Hex;
  const poolCodeHash = hashes[2] as Hex;
  const allowlisted =
    input.profile.mechanism.tokenRuntimeCodeHashes.some(
      (expected) => expected.toLowerCase() === tokenCodeHash.toLowerCase(),
    ) &&
    input.profile.mechanism.poolRuntimeCodeHashes.some(
      (expected) => expected.toLowerCase() === poolCodeHash.toLowerCase(),
    );
  const requiredCodeIdentityTier = input.requiredCodeIdentityTier ?? "PROFILE_ALLOWLISTED";
  if (requiredCodeIdentityTier === "PROFILE_ALLOWLISTED" && !allowlisted) {
    throw new CanonicalInvariantError(
      "PROFILE_UNSUPPORTED",
      "token or pool code hash is not allowlisted",
    );
  }
  return Object.freeze({
    factoryCodeHash,
    tokenCodeHash,
    poolCodeHash,
    codeIdentityTier: allowlisted ? "PROFILE_ALLOWLISTED" : "NON_EMPTY_OBSERVED",
  });
}
