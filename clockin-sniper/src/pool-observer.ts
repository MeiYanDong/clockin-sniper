import { BPS_DENOMINATOR, type FeeObservation } from "./domain.js";
import {
  assertAddress,
  assertHex,
  decodeBool,
  decodeUint256,
  hexToBigInt,
  quantityToHex,
} from "./rpc/hex.js";
import type { Hex, JsonRpcRequester } from "./rpc/types.js";

export type ExternalBuyRule =
  | { readonly kind: "always" }
  | { readonly kind: "boolean_call"; readonly callData: Hex }
  | { readonly kind: "block_after"; readonly launchBlock: bigint }
  | { readonly kind: "block_at_or_after"; readonly firstExternalBuyBlock: bigint };

export interface PoolObserverConfig {
  readonly poolAddress: Hex;
  readonly feeCallData: Hex;
  readonly externalBuyRule: ExternalBuyRule;
}

interface EthCall {
  readonly to: Hex;
  readonly data: Hex;
}

export class JsonRpcPoolObserver {
  readonly #requester: JsonRpcRequester;
  readonly #config: PoolObserverConfig;
  readonly #now: () => number;

  constructor(
    requester: JsonRpcRequester,
    config: PoolObserverConfig,
    now: () => number = Date.now,
  ) {
    assertAddress("poolAddress", config.poolAddress);
    assertHex("feeCallData", config.feeCallData);
    if (config.externalBuyRule.kind === "boolean_call") {
      assertHex("externalBuyRule.callData", config.externalBuyRule.callData);
    }
    if (config.externalBuyRule.kind === "block_after" && config.externalBuyRule.launchBlock < 0n) {
      throw new RangeError("launchBlock must not be negative");
    }
    if (
      config.externalBuyRule.kind === "block_at_or_after" &&
      config.externalBuyRule.firstExternalBuyBlock < 0n
    ) {
      throw new RangeError("firstExternalBuyBlock must not be negative");
    }

    this.#requester = requester;
    this.#config = Object.freeze({ ...config });
    this.#now = now;
  }

  async observe(): Promise<FeeObservation> {
    const blockNumberHex = await this.#requester.request<string>("eth_blockNumber");
    const blockNumber = hexToBigInt("eth_blockNumber", blockNumberHex);
    return this.observeAt(blockNumber);
  }

  /** Reads every decision input against one caller-supplied canonical block. */
  async observeAt(blockNumber: bigint): Promise<FeeObservation> {
    if (blockNumber < 0n) {
      throw new RangeError("blockNumber must not be negative");
    }
    const blockTag = quantityToHex(blockNumber);

    const feePromise = this.#ethCall(this.#config.feeCallData, blockTag);
    const externalBuyPromise = this.#externalBuyAllowed(blockNumber, blockTag);
    const [feeResult, externalBuyAllowed] = await Promise.all([feePromise, externalBuyPromise]);
    const fee = decodeUint256("fee eth_call result", feeResult);
    if (fee > BPS_DENOMINATOR) {
      throw new RangeError(`contract fee ${fee} exceeds 10000 bps`);
    }

    return Object.freeze({
      observedAtMs: this.#now(),
      blockNumber,
      feeBps: Number(fee),
      externalBuyAllowed,
    });
  }

  async #externalBuyAllowed(blockNumber: bigint, blockTag: Hex): Promise<boolean> {
    const rule = this.#config.externalBuyRule;
    switch (rule.kind) {
      case "always":
        return true;
      case "boolean_call": {
        const result = await this.#ethCall(rule.callData, blockTag);
        return decodeBool("external-buy eth_call result", result);
      }
      case "block_after":
        return blockNumber > rule.launchBlock;
      case "block_at_or_after":
        return blockNumber >= rule.firstExternalBuyBlock;
    }
  }

  #ethCall(data: Hex, blockTag: Hex): Promise<string> {
    const call: EthCall = Object.freeze({ to: this.#config.poolAddress, data });
    return this.#requester.request<string>("eth_call", [call, blockTag]);
  }
}

export class RacingPoolObserver {
  readonly #observers: readonly JsonRpcPoolObserver[];

  constructor(observers: readonly JsonRpcPoolObserver[]) {
    if (observers.length === 0) {
      throw new RangeError("at least one pool observer is required");
    }
    this.#observers = Object.freeze([...observers]);
  }

  observe(): Promise<FeeObservation> {
    return Promise.any(this.#observers.map((observer) => observer.observe()));
  }
}
