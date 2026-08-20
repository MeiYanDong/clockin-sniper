import { Interface, isHexString, toBeHex, zeroPadValue } from "ethers";

import {
  CLOCKIN_APPROVED_LAUNCH_CREATOR,
  CLOCKIN_WETH_SAFE_LAUNCH_PROFILE,
  decodeStonkSafeLaunchQuotedArmed,
  decodeStonkSafeLaunchQuotedCreated,
  STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
  STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
} from "../adapters/stonk-safe-launch-quoted.js";
import { hexToBigInt, quantityToHex } from "../rpc/hex.js";
import type { Hex, JsonRpcRequester } from "../rpc/types.js";
import {
  parseRpcContractLog,
  type RawRpcContractLog,
  type RpcContractLog,
} from "../rpc/websocket-logs.js";
import {
  createPublicLaunchHandoffRecord,
  PUBLIC_LAUNCH_HANDOFF_DEFAULT_DIRECTORY,
  type PublicLaunchHandoffRecord,
  PublicLaunchHandoffStore,
} from "../runtime/public-launch-handoff.js";

const DEFAULT_MAXIMUM_BLOCKS_PER_QUERY = 2_000n;
const DEFAULT_CONFIRMATION_DEPTH = 2n;
const erc20MetadataInterface = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);

export interface PublicSafeLaunchHandoffSnapshot {
  readonly cursor: string;
  readonly confirmedHead: string | null;
  readonly cursorLagBlocks: string | null;
  readonly caughtUp: boolean;
  readonly handoff: null | Readonly<{
    handoffId: string;
    launchId: string;
    tokenAddress: string;
    blockNumber: string;
    blockHash: string;
    transactionHash: string;
  }>;
  readonly lastError: string | null;
  readonly conflict: boolean;
  readonly metadataObservation: PublicSafeLaunchMetadataObservation | null;
}

export interface PublicSafeLaunchMetadataObservation {
  readonly launchId: string;
  readonly tokenAddress: string;
  readonly blockNumber: string;
  readonly state: "OBSERVED" | "UNAVAILABLE";
  readonly name: string | null;
  readonly symbol: string | null;
  readonly error: string | null;
  readonly observedAt: string;
}

export interface PublicSafeLaunchHandoffScanResult {
  readonly fromBlock: bigint | null;
  readonly toBlock: bigint;
  readonly queriedChunks: number;
  readonly matchingLogs: number;
  readonly created: number;
  readonly duplicates: number;
  readonly armedSignals: number;
}

export interface PublicSafeLaunchHandoffProducerOptions {
  readonly requester: JsonRpcRequester;
  readonly directory?: string;
  readonly maximumBlocksPerQuery?: bigint;
  readonly confirmationDepth?: bigint;
  readonly initialCursor?: bigint;
  readonly now?: () => string;
  readonly onMetadataObservation?: (
    observation: PublicSafeLaunchMetadataObservation,
  ) => void | Promise<void>;
}

interface RawRpcBlock {
  readonly number?: unknown;
  readonly hash?: unknown;
}

interface RawRpcTransactionReceipt {
  readonly transactionHash?: unknown;
  readonly blockNumber?: unknown;
  readonly blockHash?: unknown;
  readonly status?: unknown;
  readonly logs?: unknown;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

function hex32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error(`${label} is not bytes32`);
  }
  return value as Hex;
}

function canonicalBlock(raw: RawRpcBlock | null, expectedNumber: bigint): Hex {
  if (raw === null) throw new Error(`public canonical block ${expectedNumber} is unavailable`);
  if (typeof raw.number !== "string") throw new Error("public canonical block has no number");
  const number = hexToBigInt("public canonical block.number", raw.number);
  if (number !== expectedNumber) throw new Error("public RPC returned the wrong exact block");
  return hex32(raw.hash, "public canonical block.hash");
}

function sameLog(left: RpcContractLog, right: RpcContractLog): boolean {
  return (
    left.address.toLowerCase() === right.address.toLowerCase() &&
    left.blockNumber === right.blockNumber &&
    left.transactionHash.toLowerCase() === right.transactionHash.toLowerCase() &&
    left.logIndex === right.logIndex &&
    left.data.toLowerCase() === right.data.toLowerCase() &&
    left.topics.length === right.topics.length &&
    left.topics.every((topic, index) => topic.toLowerCase() === right.topics[index]?.toLowerCase())
  );
}

async function bindLogToCanonicalBlock(
  requester: JsonRpcRequester,
  log: RpcContractLog,
  label: "created" | "armed",
): Promise<Hex> {
  const receipt = await requester.request<RawRpcTransactionReceipt | null>(
    "eth_getTransactionReceipt",
    [log.transactionHash],
  );
  if (receipt === null) throw new Error(`public ${label} transaction receipt is unavailable`);
  const receiptTransactionHash = hex32(
    receipt.transactionHash,
    `public ${label} receipt transactionHash`,
  );
  if (receiptTransactionHash.toLowerCase() !== log.transactionHash.toLowerCase()) {
    throw new Error(`public ${label} receipt transactionHash mismatch`);
  }
  if (typeof receipt.blockNumber !== "string") {
    throw new Error(`public ${label} receipt has no blockNumber`);
  }
  const receiptBlockNumber = hexToBigInt(
    `public ${label} receipt.blockNumber`,
    receipt.blockNumber,
  );
  if (receiptBlockNumber !== log.blockNumber) {
    throw new Error(`public ${label} receipt blockNumber mismatch`);
  }
  const receiptBlockHash = hex32(receipt.blockHash, `public ${label} receipt blockHash`);
  if (receipt.status !== "0x1") throw new Error(`public ${label} receipt did not succeed`);
  if (!Array.isArray(receipt.logs)) {
    throw new Error(`public ${label} receipt logs are unavailable`);
  }
  const receiptHasExactLog = receipt.logs.some((raw) => {
    try {
      return sameLog(parseRpcContractLog(requester.providerId, raw as RawRpcContractLog), log);
    } catch {
      return false;
    }
  });
  if (!receiptHasExactLog) {
    throw new Error(`public ${label} receipt does not contain the exact log`);
  }
  const block = await requester.request<RawRpcBlock | null>("eth_getBlockByNumber", [
    quantityToHex(log.blockNumber),
    false,
  ]);
  const blockHash = canonicalBlock(block, log.blockNumber);
  if (blockHash.toLowerCase() !== receiptBlockHash.toLowerCase()) {
    throw new Error(`public ${label} receipt is not in the canonical exact block`);
  }
  return blockHash;
}

function redacted(
  record: PublicLaunchHandoffRecord | null,
): PublicSafeLaunchHandoffSnapshot["handoff"] {
  return record === null
    ? null
    : Object.freeze({
        handoffId: record.handoffId,
        launchId: record.created.launchId,
        tokenAddress: record.created.tokenAddress,
        blockNumber: record.created.blockNumber,
        blockHash: record.created.blockHash,
        transactionHash: record.created.transactionHash,
      });
}

async function readErc20MetadataField(
  requester: JsonRpcRequester,
  tokenAddress: string,
  field: "name" | "symbol",
  blockNumber: bigint,
): Promise<string> {
  const raw = await requester.request<unknown>("eth_call", [
    { to: tokenAddress, data: erc20MetadataInterface.encodeFunctionData(field) },
    quantityToHex(blockNumber),
  ]);
  if (typeof raw !== "string" || !isHexString(raw)) {
    throw new Error(`public token metadata ${field} returned invalid ABI data`);
  }
  let decoded: readonly unknown[];
  try {
    decoded = erc20MetadataInterface.decodeFunctionResult(field, raw);
  } catch (error) {
    throw new Error(`public token metadata ${field} ABI decode failed`, { cause: error });
  }
  if (decoded.length !== 1 || typeof decoded[0] !== "string" || decoded[0].length === 0) {
    throw new Error(`public token metadata ${field} did not return one non-empty string`);
  }
  return decoded[0];
}

async function readClockInMetadataForAudit(
  requester: JsonRpcRequester,
  tokenAddress: string,
  blockNumber: bigint,
): Promise<Readonly<{ name: string; symbol: string }>> {
  const [name, symbol] = await Promise.all([
    readErc20MetadataField(requester, tokenAddress, "name", blockNumber),
    readErc20MetadataField(requester, tokenAddress, "symbol", blockNumber),
  ]);
  return Object.freeze({ name, symbol });
}

export class PublicSafeLaunchHandoffProducer {
  readonly #requester: JsonRpcRequester;
  readonly #store: PublicLaunchHandoffStore;
  readonly #maximumBlocksPerQuery: bigint;
  readonly #confirmationDepth: bigint;
  readonly #initialCursor: bigint;
  readonly #now: () => string;
  readonly #onMetadataObservation:
    | ((observation: PublicSafeLaunchMetadataObservation) => void | Promise<void>)
    | undefined;
  #cursor: bigint;
  #confirmedHead: bigint | null = null;
  #current: PublicLaunchHandoffRecord | null = null;
  #lastError: string | null = null;
  #conflict = false;
  #metadataObservation: PublicSafeLaunchMetadataObservation | null = null;
  #initialized = false;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: PublicSafeLaunchHandoffProducerOptions) {
    const maximumBlocksPerQuery = options.maximumBlocksPerQuery ?? DEFAULT_MAXIMUM_BLOCKS_PER_QUERY;
    if (maximumBlocksPerQuery < 1n || maximumBlocksPerQuery > DEFAULT_MAXIMUM_BLOCKS_PER_QUERY) {
      throw new RangeError("public handoff getLogs chunk must be between 1 and 2000 blocks");
    }
    const confirmationDepth = options.confirmationDepth ?? DEFAULT_CONFIRMATION_DEPTH;
    if (confirmationDepth < 0n || confirmationDepth > 12n) {
      throw new RangeError("public handoff confirmation depth must be between 0 and 12 blocks");
    }
    const initialCursor = options.initialCursor ?? CLOCKIN_WETH_SAFE_LAUNCH_PROFILE.startBlock - 1n;
    if (initialCursor < 0n)
      throw new RangeError("public handoff initial cursor cannot be negative");
    this.#requester = options.requester;
    this.#store = new PublicLaunchHandoffStore(
      options.directory ?? PUBLIC_LAUNCH_HANDOFF_DEFAULT_DIRECTORY,
    );
    this.#maximumBlocksPerQuery = maximumBlocksPerQuery;
    this.#confirmationDepth = confirmationDepth;
    this.#initialCursor = initialCursor;
    this.#cursor = initialCursor;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#onMetadataObservation = options.onMetadataObservation;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.#store.initialize();
    const [cursor, current, invalidation] = await Promise.all([
      this.#store.readCursor(),
      this.#store.readCurrent(),
      this.#store.readInvalidation(),
    ]);
    this.#cursor = cursor === null ? this.#initialCursor : BigInt(cursor.lastCompletedBlock);
    if (invalidation !== null && this.#cursor > BigInt(invalidation.rewindToBlock)) {
      this.#cursor = BigInt(invalidation.rewindToBlock);
      await this.#store.commitCursor(this.#cursor, this.#now());
    }
    this.#current = current;
    this.#initialized = true;
  }

  snapshot(): PublicSafeLaunchHandoffSnapshot {
    const lag =
      this.#confirmedHead === null || this.#cursor >= this.#confirmedHead
        ? 0n
        : this.#confirmedHead - this.#cursor;
    return Object.freeze({
      cursor: this.#cursor.toString(),
      confirmedHead: this.#confirmedHead?.toString() ?? null,
      cursorLagBlocks: this.#confirmedHead === null ? null : lag.toString(),
      caughtUp: this.#confirmedHead !== null && lag === 0n,
      handoff: redacted(this.#current),
      lastError: this.#lastError,
      conflict: this.#conflict,
      metadataObservation: this.#metadataObservation,
    });
  }

  #observeMetadataWithoutBlocking(input: {
    readonly launchId: bigint;
    readonly tokenAddress: string;
    readonly blockNumber: bigint;
    readonly canonicalBlockHash: Hex;
  }): void {
    void (async () => {
      let observation: PublicSafeLaunchMetadataObservation;
      try {
        const metadata = await readClockInMetadataForAudit(
          this.#requester,
          input.tokenAddress,
          input.blockNumber,
        );
        const observedBlockHash = await this.#readCanonicalBlockHash(input.blockNumber);
        if (observedBlockHash.toLowerCase() !== input.canonicalBlockHash.toLowerCase()) {
          throw new Error("public canonical block changed during asynchronous metadata audit");
        }
        observation = Object.freeze({
          launchId: input.launchId.toString(),
          tokenAddress: input.tokenAddress,
          blockNumber: input.blockNumber.toString(),
          state: "OBSERVED",
          name: metadata.name,
          symbol: metadata.symbol,
          error: null,
          observedAt: this.#now(),
        });
      } catch (error) {
        observation = Object.freeze({
          launchId: input.launchId.toString(),
          tokenAddress: input.tokenAddress,
          blockNumber: input.blockNumber.toString(),
          state: "UNAVAILABLE",
          name: null,
          symbol: null,
          error: errorMessage(error),
          observedAt: this.#now(),
        });
      }
      this.#metadataObservation = observation;
      try {
        await this.#onMetadataObservation?.(observation);
      } catch {
        // Audit sinks are deliberately outside the handoff liveness path.
      }
    })();
  }

  async signalExistingCurrent(): Promise<boolean> {
    await this.initialize();
    await this.#validateCurrentCanonical();
    const current = await this.#store.signalCurrent(this.#now());
    this.#current = current;
    return current !== null;
  }

  async #readCanonicalBlockHash(blockNumber: bigint): Promise<Hex> {
    const block = await this.#requester.request<RawRpcBlock | null>("eth_getBlockByNumber", [
      quantityToHex(blockNumber),
      false,
    ]);
    return canonicalBlock(block, blockNumber);
  }

  async #validateCurrentCanonical(): Promise<"NONE" | "CANONICAL" | "INVALIDATED"> {
    if (this.#current === null) return "NONE";
    const current = this.#current;
    const blockNumber = BigInt(current.created.blockNumber);
    const firstObserved = await this.#readCanonicalBlockHash(blockNumber);
    if (firstObserved.toLowerCase() === current.created.blockHash.toLowerCase()) {
      return "CANONICAL";
    }
    // A single surprising response may be a lagging or faulty public node. Only
    // install a tombstone after the same endpoint repeats the replacement hash.
    const secondObserved = await this.#readCanonicalBlockHash(blockNumber);
    if (secondObserved.toLowerCase() !== firstObserved.toLowerCase()) {
      throw new Error("public RPC returned inconsistent canonical block hashes");
    }
    const rewindToBlock = blockNumber - 1n;
    await this.#store.invalidateCurrentForReorg({
      expected: current,
      observedCanonicalBlockHash: secondObserved,
      rewindToBlock,
      observedAt: this.#now(),
    });
    this.#cursor = rewindToBlock;
    this.#current = null;
    this.#conflict = false;
    return "INVALIDATED";
  }

  scanToHead(head: bigint): Promise<PublicSafeLaunchHandoffScanResult> {
    const run = this.#queue.then(
      () => this.#scanToHead(head),
      () => this.#scanToHead(head),
    );
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #scanToHead(head: bigint): Promise<PublicSafeLaunchHandoffScanResult> {
    await this.initialize();
    if (head < 0n) throw new RangeError("public handoff head cannot be negative");
    try {
      await this.#validateCurrentCanonical();
    } catch (error) {
      this.#lastError = errorMessage(error);
      throw error;
    }
    const confirmedHead = head >= this.#confirmationDepth ? head - this.#confirmationDepth : 0n;
    this.#confirmedHead = confirmedHead;
    if (confirmedHead <= this.#cursor) {
      this.#lastError = null;
      return Object.freeze({
        fromBlock: null,
        toBlock: confirmedHead,
        queriedChunks: 0,
        matchingLogs: 0,
        created: 0,
        duplicates: 0,
        armedSignals: 0,
      });
    }
    const fromBlock = this.#cursor + 1n;
    let queriedChunks = 0;
    let matchingLogs = 0;
    let created = 0;
    let duplicates = 0;
    let armedSignals = 0;
    try {
      for (
        let chunkFrom = fromBlock;
        chunkFrom <= confirmedHead;
        chunkFrom += this.#maximumBlocksPerQuery
      ) {
        const candidateEnd = chunkFrom + this.#maximumBlocksPerQuery - 1n;
        const chunkTo = candidateEnd < confirmedHead ? candidateEnd : confirmedHead;
        const rawLogs = await this.#requester.request<readonly RawRpcContractLog[]>("eth_getLogs", [
          {
            address: CLOCKIN_WETH_SAFE_LAUNCH_PROFILE.factoryAddress,
            topics: [
              STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
              null,
              null,
              zeroPadValue(CLOCKIN_APPROVED_LAUNCH_CREATOR, 32),
            ],
            fromBlock: quantityToHex(chunkFrom),
            toBlock: quantityToHex(chunkTo),
          },
        ]);
        queriedChunks += 1;
        if (!Array.isArray(rawLogs)) throw new Error("public eth_getLogs result is not an array");
        const logs = rawLogs
          .map((raw) => parseRpcContractLog(this.#requester.providerId, raw))
          .sort((left, right) => {
            if (left.blockNumber !== right.blockNumber) {
              return left.blockNumber < right.blockNumber ? -1 : 1;
            }
            return left.logIndex < right.logIndex ? -1 : left.logIndex > right.logIndex ? 1 : 0;
          });
        matchingLogs += logs.length;
        for (const log of logs) {
          if (log.removed) {
            throw new Error("public Safe Launch query returned a removed log");
          }
          const decoded = decodeStonkSafeLaunchQuotedCreated(log, CLOCKIN_WETH_SAFE_LAUNCH_PROFILE);
          if (
            decoded.creatorAddress.toLowerCase() !== CLOCKIN_APPROVED_LAUNCH_CREATOR.toLowerCase()
          ) {
            throw new Error("public Safe Launch result creator does not match exact filter");
          }
          if (decoded.externalToken) {
            throw new Error("public Safe Launch handoff rejects externalToken=true");
          }
          const canonicalBlockHash = await bindLogToCanonicalBlock(this.#requester, log, "created");
          const record = createPublicLaunchHandoffRecord(decoded, canonicalBlockHash, this.#now());
          let result = await this.#store.publish(record);
          if (result.state === "CONFLICT") {
            this.#current = result.current;
            const canonicalState = await this.#validateCurrentCanonical();
            if (canonicalState === "INVALIDATED") {
              result = await this.#store.publish(record);
            }
            if (result.state === "CONFLICT") {
              this.#current = result.current;
              this.#conflict = true;
              throw new Error(
                `second public Safe Launch candidate conflicts with ${result.current.handoffId}`,
              );
            }
          }
          this.#current = result.record;
          if (result.state === "CREATED") created += 1;
          else duplicates += 1;
          this.#observeMetadataWithoutBlocking({
            launchId: decoded.id,
            tokenAddress: decoded.tokenAddress,
            blockNumber: decoded.blockNumber,
            canonicalBlockHash,
          });
        }
        const current = this.#current;
        if (current !== null) {
          const rawArmedLogs = await this.#requester.request<readonly RawRpcContractLog[]>(
            "eth_getLogs",
            [
              {
                address: CLOCKIN_WETH_SAFE_LAUNCH_PROFILE.factoryAddress,
                topics: [
                  STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
                  toBeHex(BigInt(current.created.launchId), 32),
                ],
                fromBlock: quantityToHex(chunkFrom),
                toBlock: quantityToHex(chunkTo),
              },
            ],
          );
          if (!Array.isArray(rawArmedLogs)) {
            throw new Error("public Armed eth_getLogs result is not an array");
          }
          const armedLogs = rawArmedLogs
            .map((raw) => parseRpcContractLog(this.#requester.providerId, raw))
            .sort((left, right) => {
              if (left.blockNumber !== right.blockNumber) {
                return left.blockNumber < right.blockNumber ? -1 : 1;
              }
              return left.logIndex < right.logIndex ? -1 : left.logIndex > right.logIndex ? 1 : 0;
            });
          for (const log of armedLogs) {
            if (log.removed)
              throw new Error("public Safe Launch query returned a removed Armed log");
            const armed = decodeStonkSafeLaunchQuotedArmed(log, CLOCKIN_WETH_SAFE_LAUNCH_PROFILE);
            if (armed.id !== BigInt(current.created.launchId)) {
              throw new Error("public Armed result id does not match exact filter");
            }
            await bindLogToCanonicalBlock(this.#requester, log, "armed");
            const signaled = await this.#store.signalCurrent(this.#now());
            if (signaled === null || signaled.handoffId !== current.handoffId) {
              throw new Error("public Armed signal no longer matches the active handoff");
            }
            armedSignals += 1;
          }
        }
        // Each successful bounded chunk is its own durable checkpoint. A
        // timeout in a later chunk resumes here instead of replaying the full
        // historical range from the deployment block.
        await this.#store.commitCursor(chunkTo, this.#now());
        this.#cursor = chunkTo;
      }
      this.#lastError = null;
      return Object.freeze({
        fromBlock,
        toBlock: confirmedHead,
        queriedChunks,
        matchingLogs,
        created,
        duplicates,
        armedSignals,
      });
    } catch (error) {
      this.#lastError = errorMessage(error);
      throw error;
    }
  }
}
