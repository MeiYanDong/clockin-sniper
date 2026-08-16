import {
  FunctionFragment,
  Interface,
  ZeroAddress,
  getAddress,
  isHexString,
  keccak256,
} from "ethers";

import type { Address, LaunchIdentity, PositionLot, RouteQuote } from "../core/canonical.js";
import { createNetRouteQuote } from "../exit/route-quote.js";
import { quantityToHex } from "../rpc/hex.js";
import type { Hex, JsonRpcRequester } from "../rpc/types.js";
import type {
  ProductionExitRoute,
  ProductionProtocolProfile,
} from "../runtime/production-profile.js";

const ALLOWANCE_ABI = new Interface([
  "function allowance(address owner,address spender) view returns (uint256)",
]);
const APPROVE_ABI = new Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
]);

interface RpcBlock {
  readonly number?: unknown;
  readonly hash?: unknown;
  readonly timestamp?: unknown;
}

export interface ConfiguredExitQuote {
  readonly quote: RouteQuote;
  readonly approvalRequired: boolean;
  readonly routeTarget: Address;
  readonly quoteBlockHash: `0x${string}`;
  readonly quoteBlockTimestamp: bigint;
}

export interface ConfiguredApprovalTemplate {
  readonly to: Address;
  readonly calldata: `0x${string}`;
  readonly valueRaw: 0n;
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

export interface ConfiguredSellTemplate {
  readonly routeId: string;
  readonly to: Address;
  readonly calldata: `0x${string}`;
  readonly valueRaw: 0n;
  readonly tokenInputRaw: bigint;
  readonly expectedOutputRaw: bigint;
  readonly minOutputRaw: bigint;
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly deadlineTimestamp: bigint;
}

function rpcQuantity(value: unknown, label: string): bigint {
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

function functionBinding(
  abi: string,
): Readonly<{ fragment: FunctionFragment; contract: Interface }> {
  const fragment = FunctionFragment.from(abi);
  return Object.freeze({ fragment, contract: new Interface([fragment]) });
}

function quoteOutput(value: unknown): bigint {
  if (Array.isArray(value)) {
    if (value.length === 0) throw new Error("configured exit quote returned an empty path result");
    return BigInt(String(value[value.length - 1]));
  }
  return BigInt(String(value));
}

export class ConfiguredExitRouteRuntime {
  readonly #requester: JsonRpcRequester;
  readonly #profile: ProductionProtocolProfile;
  readonly #route: ProductionExitRoute;
  readonly #identity: LaunchIdentity | undefined;
  readonly #target: Address;
  readonly #approvalSpender: Address | undefined;
  readonly #quote: Readonly<{ fragment: FunctionFragment; contract: Interface }>;
  readonly #sell: Readonly<{ fragment: FunctionFragment; contract: Interface }>;

  constructor(input: {
    readonly requester: JsonRpcRequester;
    readonly profile: ProductionProtocolProfile;
    readonly route: ProductionExitRoute;
    readonly identity?: LaunchIdentity;
  }) {
    const bound = input.profile.exit.routes.find((route) => route.routeId === input.route.routeId);
    if (bound === undefined || bound !== input.route) {
      throw new Error("configured exit route must be the immutable route bound to the profile");
    }
    if (input.route.quoteOutputKind !== "EXECUTABLE_BEFORE_GAS") {
      throw new Error("configured exit route quote semantics are unsupported");
    }
    if (input.route.quoteAsset.toLowerCase() !== ZeroAddress.toLowerCase()) {
      throw new Error("configured production exit currently reconciles native ETH quote proceeds");
    }
    if (input.route.allowanceMode === "PERMIT") {
      throw new Error("configured production exit does not implement permit signing");
    }
    let target: Address;
    if (input.route.targetMode === "FIXED") {
      if (input.route.target === undefined) throw new Error("fixed exit route has no target");
      target = input.route.target;
    } else {
      if (input.identity === undefined) {
        throw new Error("launch-pool exit route requires a frozen launch identity");
      }
      if (
        input.identity.state !== "FROZEN" ||
        input.identity.factoryProfileId !== input.profile.profileId ||
        input.identity.mechanismProfileId !== input.profile.mechanism.profileId
      ) {
        throw new Error("launch-pool exit identity is not bound to the production profile");
      }
      if (
        input.identity.poolRuntimeCodeHash.toLowerCase() !==
        input.route.runtimeCodeHash.toLowerCase()
      ) {
        throw new Error("launch-pool exit identity code hash is not bound to the route");
      }
      target = getAddress(input.identity.poolAddress) as Address;
    }
    let approvalSpender: Address | undefined;
    if (input.route.approvalSpenderMode === "FIXED") {
      approvalSpender = input.route.approvalSpender;
    } else if (input.route.approvalSpenderMode === "ROUTE_TARGET") {
      approvalSpender = target;
    }
    this.#requester = input.requester;
    this.#profile = input.profile;
    this.#route = input.route;
    this.#identity = input.identity;
    this.#target = target;
    this.#approvalSpender = approvalSpender;
    this.#quote = functionBinding(input.route.quoteFunctionAbi);
    this.#sell = functionBinding(input.route.sellFunctionAbi);
  }

  get route(): ProductionExitRoute {
    return this.#route;
  }

  get target(): Address {
    return this.#target;
  }

  get approvalSpender(): Address | undefined {
    return this.#approvalSpender;
  }

  async verifyCodeIdentity(blockNumber: bigint): Promise<`0x${string}`> {
    const code = await this.#requester.request<Hex>("eth_getCode", [
      this.#target,
      quantityToHex(blockNumber),
    ]);
    if (code === "0x") throw new Error(`exit route ${this.#route.routeId} has no code`);
    const actual = keccak256(code).toLowerCase();
    if (actual !== this.#route.runtimeCodeHash.toLowerCase()) {
      throw new Error(`exit route ${this.#route.routeId} runtime code hash drifted`);
    }
    return actual as `0x${string}`;
  }

  async quoteLot(lot: PositionLot, blockNumber: bigint): Promise<ConfiguredExitQuote> {
    if (lot.strategyId !== "clockin-mainnet-v1") {
      throw new Error("configured exit only accepts the ClockIn production strategy");
    }
    if (
      this.#identity !== undefined &&
      (lot.launchId !== this.#identity.launchId ||
        lot.tokenAddress.toLowerCase() !== this.#identity.tokenAddress.toLowerCase())
    ) {
      throw new Error("position lot is not bound to the launch-pool exit identity");
    }
    if (BigInt(lot.remainingRaw) <= 0n) throw new Error("closed lots cannot be quoted");
    const block = await this.#readBlock(blockNumber);
    await this.verifyCodeIdentity(blockNumber);
    const approvalRequired = await this.#approvalRequired(lot, blockNumber);
    const path = this.#pathFor(lot.tokenAddress);
    const args =
      this.#route.quoteCallLayout === "TOKEN_IN"
        ? [BigInt(lot.remainingRaw)]
        : [BigInt(lot.remainingRaw), path];
    const calldata = this.#quote.contract.encodeFunctionData(this.#quote.fragment, args);
    const encoded = await this.#requester.request<Hex>("eth_call", [
      { to: this.#target, data: calldata },
      quantityToHex(blockNumber),
    ]);
    const decoded = this.#quote.contract.decodeFunctionResult(this.#quote.fragment, encoded);
    if (decoded.length !== 1) throw new Error("configured exit quote returned the wrong arity");
    const executableBeforeGas = quoteOutput(decoded[0]);
    if (executableBeforeGas <= 0n) throw new Error("configured exit route returned no output");
    const maxFee = BigInt(this.#route.maximumFeePerGasWei);
    const observedAt = new Date().toISOString();
    const expiresAt = new Date(
      Date.parse(observedAt) + this.#route.quoteMaximumAgeMs,
    ).toISOString();
    const quote = createNetRouteQuote({
      strategyId: lot.strategyId,
      launchId: lot.launchId,
      revision: this.#profile.revision,
      lotId: lot.lotId,
      routeId: this.#route.routeId,
      routeKind: this.#route.routeKind,
      tokenInputRaw: BigInt(lot.remainingRaw),
      grossOutputRaw: executableBeforeGas,
      // The exact protocol call already reflects tax, pool fee and curve/AMM impact.
      sellTaxRaw: 0n,
      priceImpactRaw: 0n,
      approvalGasRaw: approvalRequired ? BigInt(this.#route.approvalGasLimit) * maxFee : 0n,
      executionGasRaw: BigInt(this.#route.sellGasLimit) * maxFee,
      quoteBlock: blockNumber,
      observedAt,
      expiresAt,
      evidenceIds: Object.freeze([
        ...this.#route.evidenceIds,
        `route-code:${this.#target}:${this.#route.runtimeCodeHash}`,
        `route-quote:${blockNumber}:${block.hash}`,
        "quote-semantics:executable-before-gas",
      ]),
    });
    return Object.freeze({
      quote,
      approvalRequired,
      routeTarget: this.#target,
      quoteBlockHash: block.hash,
      quoteBlockTimestamp: block.timestamp,
    });
  }

  buildApproval(tokenAddress: Address, tokenInputRaw: bigint): ConfiguredApprovalTemplate {
    if (this.#route.allowanceMode !== "APPROVE" || this.#approvalSpender === undefined) {
      throw new Error(`exit route ${this.#route.routeId} does not require ERC20 approve`);
    }
    if (tokenInputRaw <= 0n) throw new RangeError("approval token input must be positive");
    return Object.freeze({
      to: getAddress(tokenAddress) as Address,
      calldata: APPROVE_ABI.encodeFunctionData("approve", [
        this.#approvalSpender,
        tokenInputRaw,
      ]) as `0x${string}`,
      valueRaw: 0n,
      gasLimit: BigInt(this.#route.approvalGasLimit),
      maxFeePerGas: BigInt(this.#route.maximumFeePerGasWei),
      maxPriorityFeePerGas: BigInt(this.#route.maximumPriorityFeePerGasWei),
    });
  }

  buildSell(input: {
    readonly lot: PositionLot;
    readonly quote: RouteQuote;
    readonly tokenInputRaw: bigint;
    readonly minOutputRaw: bigint;
    readonly deadlineTimestamp: bigint;
  }): ConfiguredSellTemplate {
    if (input.quote.routeId !== this.#route.routeId || input.quote.lotId !== input.lot.lotId) {
      throw new Error("sell template route, quote and lot are not canonically bound");
    }
    if (Date.parse(input.quote.expiresAt) < Date.now()) {
      throw new Error("cannot build configured sell from a stale quote");
    }
    if (
      input.tokenInputRaw <= 0n ||
      input.tokenInputRaw > BigInt(input.lot.remainingRaw) ||
      input.minOutputRaw <= 0n
    ) {
      throw new RangeError("configured sell amount or minOut is invalid");
    }
    const path = this.#pathFor(input.lot.tokenAddress);
    const args =
      this.#route.sellCallLayout === "TOKEN_IN_MIN_OUT_RECIPIENT"
        ? [input.tokenInputRaw, input.minOutputRaw, input.lot.walletAddress]
        : [
            input.tokenInputRaw,
            input.minOutputRaw,
            path,
            input.lot.walletAddress,
            input.deadlineTimestamp,
          ];
    return Object.freeze({
      routeId: this.#route.routeId,
      to: this.#target,
      calldata: this.#sell.contract.encodeFunctionData(this.#sell.fragment, args) as `0x${string}`,
      valueRaw: 0n,
      tokenInputRaw: input.tokenInputRaw,
      expectedOutputRaw:
        (BigInt(input.quote.grossOutputRaw) * input.tokenInputRaw) /
        BigInt(input.quote.tokenInputRaw),
      minOutputRaw: input.minOutputRaw,
      gasLimit: BigInt(this.#route.sellGasLimit),
      maxFeePerGas: BigInt(this.#route.maximumFeePerGasWei),
      maxPriorityFeePerGas: BigInt(this.#route.maximumPriorityFeePerGasWei),
      deadlineTimestamp: input.deadlineTimestamp,
    });
  }

  #pathFor(tokenAddress: Address): readonly Address[] {
    if (this.#route.pathMode === "NONE") {
      return Object.freeze([]);
    }
    const path =
      this.#route.pathMode === "TOKEN_PREFIX"
        ? Object.freeze([getAddress(tokenAddress) as Address, ...this.#route.path])
        : this.#route.path;
    if (path.length < 2) throw new Error("configured route path is incomplete");
    if (path[0]?.toLowerCase() !== tokenAddress.toLowerCase()) {
      throw new Error("configured route path does not begin with the frozen token");
    }
    return path;
  }

  async #approvalRequired(lot: PositionLot, blockNumber: bigint): Promise<boolean> {
    if (this.#route.allowanceMode === "NONE") return false;
    if (this.#approvalSpender === undefined) {
      throw new Error("configured APPROVE route has no spender");
    }
    const data = ALLOWANCE_ABI.encodeFunctionData("allowance", [
      lot.walletAddress,
      this.#approvalSpender,
    ]);
    const encoded = await this.#requester.request<Hex>("eth_call", [
      { to: lot.tokenAddress, data },
      quantityToHex(blockNumber),
    ]);
    const decoded = ALLOWANCE_ABI.decodeFunctionResult("allowance", encoded);
    return BigInt(String(decoded[0])) < BigInt(lot.remainingRaw);
  }

  async #readBlock(
    blockNumber: bigint,
  ): Promise<Readonly<{ hash: `0x${string}`; timestamp: bigint }>> {
    const block = await this.#requester.request<RpcBlock | null>("eth_getBlockByNumber", [
      quantityToHex(blockNumber),
      false,
    ]);
    if (block === null) throw new Error(`exit quote block ${blockNumber} is unavailable`);
    if (rpcQuantity(block.number, "block.number") !== blockNumber) {
      throw new Error("exit quote RPC returned the wrong exact block");
    }
    return Object.freeze({
      hash: hex32(block.hash, "block.hash"),
      timestamp: rpcQuantity(block.timestamp, "block.timestamp"),
    });
  }
}
