import { Interface, getAddress } from "ethers";

import type { LiveLedger } from "./live-ledger.js";
import type { PreparedTrancheMetadata } from "./live-transaction-source.js";
import { hexToBigInt } from "./rpc/hex.js";
import type { Hex, JsonRpcRequester } from "./rpc/types.js";

const ERC20 = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

interface RpcLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

interface RpcReceipt {
  readonly transactionHash?: string;
  readonly status?: string;
  readonly blockNumber?: string;
  readonly gasUsed?: string;
  readonly effectiveGasPrice?: string;
  readonly logs?: readonly RpcLog[];
}

export interface ReceiptOutcome {
  readonly txHash: Hex;
  readonly trancheNumber: number;
  readonly state: "success" | "success_no_tokens" | "reverted" | "unknown";
  readonly blockNumber: bigint | null;
  readonly gasCostWei: bigint | null;
  readonly tokensReceivedRaw: bigint | null;
}

export interface ReceiptReconcilerOptions {
  readonly requester: JsonRpcRequester;
  readonly ledger: LiveLedger;
  readonly tokenAddress: Hex;
  readonly beneficiaryAddress: Hex;
  readonly pollMs: number;
  readonly timeoutMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

function tokensReceived(receipt: RpcReceipt, tokenAddress: Hex, beneficiaryAddress: Hex): bigint {
  let total = 0n;
  for (const log of receipt.logs ?? []) {
    if (log.address.toLowerCase() !== tokenAddress.toLowerCase()) continue;
    try {
      const parsed = ERC20.parseLog({ topics: [...log.topics], data: log.data });
      if (
        parsed?.name === "Transfer" &&
        getAddress(String(parsed.args.to)) === getAddress(beneficiaryAddress)
      ) {
        total += BigInt(parsed.args.value.toString());
      }
    } catch {
      // A token may emit other events from the same address.
    }
  }
  return total;
}

export class ReceiptReconciler {
  readonly #requester: JsonRpcRequester;
  readonly #ledger: LiveLedger;
  readonly #tokenAddress: Hex;
  readonly #beneficiaryAddress: Hex;
  readonly #pollMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: ReceiptReconcilerOptions) {
    if (!Number.isSafeInteger(options.pollMs) || options.pollMs <= 0) {
      throw new RangeError("pollMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive safe integer");
    }
    this.#requester = options.requester;
    this.#ledger = options.ledger;
    this.#tokenAddress = options.tokenAddress;
    this.#beneficiaryAddress = options.beneficiaryAddress;
    this.#pollMs = options.pollMs;
    this.#timeoutMs = options.timeoutMs;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async reconcile(metadata: PreparedTrancheMetadata): Promise<ReceiptOutcome> {
    const expiresAt = this.#now() + this.#timeoutMs;
    let lastError: string | null = null;
    while (this.#now() <= expiresAt) {
      try {
        const receipt = await this.#requester.request<RpcReceipt | null>(
          "eth_getTransactionReceipt",
          [metadata.txHash],
        );
        if (receipt !== null) return this.#finalize(metadata, receipt);
        lastError = null;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await this.#sleep(this.#pollMs);
    }

    const outcome: ReceiptOutcome = Object.freeze({
      txHash: metadata.txHash,
      trancheNumber: metadata.trancheNumber,
      state: "unknown",
      blockNumber: null,
      gasCostWei: null,
      tokensReceivedRaw: null,
    });
    await this.#ledger.append({
      event: "reconciliation_unknown",
      intentId: metadata.intentId,
      txHash: metadata.txHash,
      tranche: metadata.trancheNumber,
      nonce: metadata.nonce,
      lastError,
    });
    return outcome;
  }

  async #finalize(metadata: PreparedTrancheMetadata, receipt: RpcReceipt): Promise<ReceiptOutcome> {
    if (receipt.status === undefined || receipt.blockNumber === undefined) {
      throw new Error("receipt is missing status or blockNumber");
    }
    if (
      receipt.transactionHash !== undefined &&
      receipt.transactionHash.toLowerCase() !== metadata.txHash.toLowerCase()
    ) {
      throw new Error("receipt transaction hash does not match the signed transaction");
    }
    const status = hexToBigInt("receipt status", receipt.status);
    if (status !== 0n && status !== 1n) {
      throw new Error("receipt status is neither success nor revert");
    }
    const blockNumber = hexToBigInt("receipt blockNumber", receipt.blockNumber);
    const gasUsed =
      receipt.gasUsed === undefined ? null : hexToBigInt("receipt gasUsed", receipt.gasUsed);
    const effectiveGasPrice =
      receipt.effectiveGasPrice === undefined
        ? null
        : hexToBigInt("receipt effectiveGasPrice", receipt.effectiveGasPrice);
    const gasCostWei =
      gasUsed === null || effectiveGasPrice === null ? null : gasUsed * effectiveGasPrice;
    const received =
      status === 1n ? tokensReceived(receipt, this.#tokenAddress, this.#beneficiaryAddress) : 0n;
    const state = status === 0n ? "reverted" : received === 0n ? "success_no_tokens" : "success";
    const outcome: ReceiptOutcome = Object.freeze({
      txHash: metadata.txHash,
      trancheNumber: metadata.trancheNumber,
      state,
      blockNumber,
      gasCostWei,
      tokensReceivedRaw: received,
    });
    await this.#ledger.append({
      event: "receipt_observed",
      intentId: metadata.intentId,
      txHash: metadata.txHash,
      tranche: metadata.trancheNumber,
      nonce: metadata.nonce,
      state,
      blockNumber: blockNumber.toString(),
      gasCostWei: gasCostWei?.toString() ?? null,
      tokensReceivedRaw: received.toString(),
    });
    return outcome;
  }
}
