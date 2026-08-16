import { Wallet, getAddress, keccak256, type TransactionRequest } from "ethers";

import type { TrancheIntent } from "./domain.js";
import type { PreparedRawTransaction, PreparedTransactionSource } from "./raw-fanout-submitter.js";
import { ROBINHOOD_MAINNET_CHAIN_ID } from "./rpc/robinhood.js";
import type { Hex } from "./rpc/types.js";

export interface PreparedTrancheMetadata {
  readonly intentId: string;
  readonly trancheNumber: number;
  readonly nonce: number;
  readonly txHash: Hex;
  readonly valueWei: bigint;
  readonly gasLimit: bigint;
  readonly maxFeePerGasWei: bigint;
  readonly maxPriorityFeePerGasWei: bigint;
}

export interface PrepareLiveTransactionsOptions {
  readonly launchId: string;
  readonly batchCount: number;
  readonly privateKey: Hex;
  readonly expectedWalletAddress: Hex;
  readonly baseNonce: bigint;
  readonly buyTo: Hex;
  readonly buyCallData: Hex;
  readonly batchValueWei: bigint;
  readonly gasLimit: bigint;
  readonly maxFeePerGasWei: bigint;
  readonly maxPriorityFeePerGasWei: bigint;
}

export class LivePreparedTransactionSource implements PreparedTransactionSource {
  readonly signerAddress: Hex;
  readonly #transactions = new Map<string, PreparedRawTransaction>();
  readonly #metadata = new Map<string, PreparedTrancheMetadata>();
  readonly #wallet: Wallet;
  readonly #options: PrepareLiveTransactionsOptions;
  #remainingPreparation: Promise<void> | null = null;

  private constructor(signerAddress: Hex, wallet: Wallet, options: PrepareLiveTransactionsOptions) {
    this.signerAddress = signerAddress;
    this.#wallet = wallet;
    this.#options = Object.freeze({ ...options });
  }

  static async prepare(
    options: PrepareLiveTransactionsOptions,
  ): Promise<LivePreparedTransactionSource> {
    const source = await LivePreparedTransactionSource.prepareFirst(options);
    await source.prepareRemaining();
    return source;
  }

  /** Signs only nonce N so the first external-block attempt is not delayed by N+1...N+9. */
  static async prepareFirst(
    options: PrepareLiveTransactionsOptions,
  ): Promise<LivePreparedTransactionSource> {
    if (!Number.isSafeInteger(options.batchCount) || options.batchCount <= 0) {
      throw new RangeError("batchCount must be a positive safe integer");
    }
    if (options.batchValueWei <= 0n) {
      throw new RangeError("batchValueWei must be positive");
    }
    if (options.gasLimit <= 0n || options.maxFeePerGasWei <= 0n) {
      throw new RangeError("gas limit and max fee must be positive");
    }
    if (
      options.maxPriorityFeePerGasWei < 0n ||
      options.maxPriorityFeePerGasWei > options.maxFeePerGasWei
    ) {
      throw new RangeError("priority fee must be between zero and max fee");
    }
    const highestNonce = options.baseNonce + BigInt(options.batchCount - 1);
    if (options.baseNonce < 0n || highestNonce > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("nonce range exceeds a safe integer");
    }

    const wallet = new Wallet(options.privateKey);
    const signerAddress = getAddress(wallet.address);
    if (signerAddress !== getAddress(options.expectedWalletAddress)) {
      throw new Error("CLOCKIN_PRIVATE_KEY does not match CLOCKIN_EXPECTED_WALLET_ADDRESS");
    }

    const source = new LivePreparedTransactionSource(signerAddress as Hex, wallet, options);
    await source.#signIndex(0);
    return source;
  }

  async prepareRemaining(): Promise<void> {
    if (this.#remainingPreparation === null) {
      this.#remainingPreparation = (async () => {
        for (let index = 1; index < this.#options.batchCount; index += 1) {
          await this.#signIndex(index);
        }
      })();
    }
    return this.#remainingPreparation;
  }

  async get(intent: TrancheIntent): Promise<PreparedRawTransaction> {
    let transaction = this.#transactions.get(intent.intentId);
    if (transaction === undefined && intent.trancheNumber > 1) {
      await this.prepareRemaining();
      transaction = this.#transactions.get(intent.intentId);
    }
    if (transaction === undefined) {
      throw new Error(`no live transaction prepared for ${intent.intentId}`);
    }
    return transaction;
  }

  metadata(intentId: string): PreparedTrancheMetadata {
    const value = this.#metadata.get(intentId);
    if (value === undefined) throw new Error(`no live metadata for ${intentId}`);
    return value;
  }

  allMetadata(): readonly PreparedTrancheMetadata[] {
    return Object.freeze(
      [...this.#metadata.values()].sort((left, right) => left.trancheNumber - right.trancheNumber),
    );
  }

  async #signIndex(index: number): Promise<void> {
    if (this.#transactions.has(`${this.#options.launchId}:tranche:${index + 1}`)) return;
    const trancheNumber = index + 1;
    const intentId = `${this.#options.launchId}:tranche:${trancheNumber}`;
    const nonce = Number(this.#options.baseNonce + BigInt(index));
    const request: TransactionRequest = {
      type: 2,
      chainId: ROBINHOOD_MAINNET_CHAIN_ID,
      nonce,
      to: this.#options.buyTo,
      data: this.#options.buyCallData,
      value: this.#options.batchValueWei,
      gasLimit: this.#options.gasLimit,
      maxFeePerGas: this.#options.maxFeePerGasWei,
      maxPriorityFeePerGas: this.#options.maxPriorityFeePerGasWei,
    };
    const rawTransaction = (await this.#wallet.signTransaction(request)) as Hex;
    const txHash = keccak256(rawTransaction) as Hex;
    this.#transactions.set(intentId, Object.freeze({ rawTransaction, expectedTxHash: txHash }));
    this.#metadata.set(
      intentId,
      Object.freeze({
        intentId,
        trancheNumber,
        nonce,
        txHash,
        valueWei: this.#options.batchValueWei,
        gasLimit: this.#options.gasLimit,
        maxFeePerGasWei: this.#options.maxFeePerGasWei,
        maxPriorityFeePerGasWei: this.#options.maxPriorityFeePerGasWei,
      }),
    );
  }
}
