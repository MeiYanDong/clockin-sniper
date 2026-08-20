import { getAddress, Interface, isHexString } from "ethers";

import {
  CLOCKIN_APPROVED_LAUNCH_CREATOR,
  CLOCKIN_WETH_SAFE_LAUNCH_PROFILE,
  decodeStonkSafeLaunchQuotedArmed,
  decodeStonkSafeLaunchQuotedCreated,
  STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
  STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
  type StonkSafeLaunchQuotedArmed,
  type StonkSafeLaunchQuotedCreated,
  type StonkSafeLaunchQuotedProfile,
} from "../adapters/stonk-safe-launch-quoted.js";
import { CanonicalInvariantError } from "../core/canonical.js";
import { hexToBigInt, quantityToHex } from "../rpc/hex.js";
import type { Hex, JsonRpcRequester } from "../rpc/types.js";
import {
  type ContractLogSubscription,
  parseRpcContractLog,
  type RawRpcContractLog,
  type RpcContractLog,
  WebSocketContractLogsClient,
} from "../rpc/websocket-logs.js";

/** Display hints only. They are not part of the creator-first authorization key. */
export const CLOCKIN_EXPECTED_TOKEN_NAME = "CLOCK IN" as const;
export const CLOCKIN_EXPECTED_TOKEN_SYMBOL = "CLOCKIN" as const;
const ERC20_METADATA_ABI = Object.freeze([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);

const metadataInterface = new Interface(ERC20_METADATA_ABI);

export interface StonkSafeLaunchTokenMetadata {
  readonly name: string;
  readonly symbol: string;
  readonly blockNumber: bigint;
}

export type StonkSafeLaunchDiscoverySource = "WSS" | "BACKFILL";

export interface StonkSafeLaunchDiscoveryResult {
  readonly created: StonkSafeLaunchQuotedCreated;
  readonly armed: StonkSafeLaunchQuotedArmed;
  readonly metadata: StonkSafeLaunchTokenMetadata | null;
  readonly createdSource: StonkSafeLaunchDiscoverySource;
  readonly armedSource: StonkSafeLaunchDiscoverySource;
}

export type StonkSafeLaunchDiscoveryEvent =
  | Readonly<{ kind: "ARMED"; padAddress: Hex; startBlock: bigint; currentBlock: bigint }>
  | Readonly<{ kind: "BACKFILL"; fromBlock: bigint; toBlock: bigint }>
  | Readonly<{ kind: "WSS_RECONNECT"; attempt: number; message: string }>
  | Readonly<{
      kind: "METADATA_OBSERVED" | "METADATA_UNAVAILABLE";
      launchId: bigint;
      tokenAddress: Hex;
      metadata: StonkSafeLaunchTokenMetadata | null;
      message?: string;
    }>
  | Readonly<{
      kind: "CANDIDATE_REJECTED";
      launchId: bigint;
      tokenAddress: Hex;
      transactionHash: Hex;
      reasons: readonly string[];
    }>
  | Readonly<{
      kind: "CANDIDATE_BOUND";
      launchId: bigint;
      tokenAddress: Hex;
      blockNumber: bigint;
    }>;

export interface StonkSafeLaunchDiscoveryOptions {
  readonly requester: JsonRpcRequester;
  readonly wssUrl: string;
  readonly profile?: StonkSafeLaunchQuotedProfile;
  readonly padAddress?: Hex;
  readonly startBlock?: bigint;
  /** Exact public-chain LaunchCreated handoff; paid discovery waits only for this launch's Armed. */
  readonly expectedCreated?: Readonly<{
    readonly factoryAddress: string;
    readonly launchId: string;
    readonly tokenAddress: string;
    readonly creatorAddress: string;
    readonly externalToken: boolean;
    readonly blockNumber: string;
    readonly transactionHash: string;
    readonly logIndex: string;
  }>;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: StonkSafeLaunchDiscoveryEvent) => void | Promise<void>;
  readonly logsClientFactory?: (
    topic0: Hex,
    onLog: (log: RpcContractLog) => void,
  ) => Promise<ContractLogSubscription>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly backfillChunkSize?: bigint;
}

function matchesExpectedCreated(
  created: StonkSafeLaunchQuotedCreated,
  expected: NonNullable<StonkSafeLaunchDiscoveryOptions["expectedCreated"]>,
): boolean {
  return (
    created.factoryAddress.toLowerCase() === expected.factoryAddress.toLowerCase() &&
    created.id === BigInt(expected.launchId) &&
    created.tokenAddress.toLowerCase() === expected.tokenAddress.toLowerCase() &&
    created.creatorAddress.toLowerCase() === expected.creatorAddress.toLowerCase() &&
    created.externalToken === expected.externalToken &&
    created.blockNumber === BigInt(expected.blockNumber) &&
    created.transactionHash.toLowerCase() === expected.transactionHash.toLowerCase() &&
    created.logIndex === BigInt(expected.logIndex)
  );
}

interface BoundCandidate {
  readonly created: StonkSafeLaunchQuotedCreated;
  readonly source: StonkSafeLaunchDiscoverySource;
}

interface ObservedArmed {
  readonly armed: StonkSafeLaunchQuotedArmed;
  readonly source: StonkSafeLaunchDiscoverySource;
}

async function latestBlock(requester: JsonRpcRequester): Promise<bigint> {
  return hexToBigInt("eth_blockNumber", await requester.request<string>("eth_blockNumber"));
}

async function readTokenMetadata(
  requester: JsonRpcRequester,
  tokenAddress: Hex,
  blockNumber: bigint,
): Promise<StonkSafeLaunchTokenMetadata> {
  const exactBlock = quantityToHex(blockNumber);
  const read = async (functionName: "name" | "symbol"): Promise<string> => {
    const data = metadataInterface.encodeFunctionData(functionName);
    const raw = await requester.request<string>("eth_call", [
      { to: tokenAddress, data },
      exactBlock,
    ]);
    if (!isHexString(raw)) throw new TypeError(`${functionName} returned invalid ABI data`);
    const result = metadataInterface.decodeFunctionResult(functionName, raw);
    if (result.length !== 1 || typeof result[0] !== "string" || result[0].length === 0) {
      throw new TypeError(`${functionName} did not return a non-empty ERC20 string`);
    }
    return result[0];
  };
  const [name, symbol] = await Promise.all([read("name"), read("symbol")]);
  return Object.freeze({ name, symbol, blockNumber });
}

const DEFAULT_BACKFILL_CHUNK_SIZE = 2_000n;

async function requestBackfillRange(
  requester: JsonRpcRequester,
  padAddress: Hex,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<readonly RpcContractLog[]> {
  if (toBlock < fromBlock) return Object.freeze([]);
  const raw = await requester.request<readonly RawRpcContractLog[]>("eth_getLogs", [
    {
      address: padAddress,
      topics: [[STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC, STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC]],
      fromBlock: quantityToHex(fromBlock),
      toBlock: quantityToHex(toBlock),
    },
  ]);
  return Object.freeze(raw.map((log) => parseRpcContractLog(requester.providerId, log)));
}

async function requestBackfillRangeAdaptive(
  requester: JsonRpcRequester,
  padAddress: Hex,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<readonly RpcContractLog[]> {
  try {
    return await requestBackfillRange(requester, padAddress, fromBlock, toBlock);
  } catch (error) {
    const message = errorMessage(error).toLowerCase();
    const isRangeLimit =
      /(?:block|query|log|getlogs).*range.*(?:large|long|wide|limit|exceed|reject)/u.test(
        message,
      ) ||
      /(?:large|long|wide|limit|exceed|reject).*range/u.test(message) ||
      /too many (?:results|logs)|response size/u.test(message);
    if (fromBlock === toBlock || !isRangeLimit) throw error;
    const midpoint = fromBlock + (toBlock - fromBlock) / 2n;
    const left = await requestBackfillRangeAdaptive(requester, padAddress, fromBlock, midpoint);
    const right = await requestBackfillRangeAdaptive(requester, padAddress, midpoint + 1n, toBlock);
    return Object.freeze([...left, ...right]);
  }
}

async function backfill(
  requester: JsonRpcRequester,
  padAddress: Hex,
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: bigint,
): Promise<readonly RpcContractLog[]> {
  if (toBlock < fromBlock) return Object.freeze([]);
  const logs: RpcContractLog[] = [];
  for (let chunkFrom = fromBlock; chunkFrom <= toBlock; chunkFrom += chunkSize) {
    const chunkTo = chunkFrom + chunkSize - 1n < toBlock ? chunkFrom + chunkSize - 1n : toBlock;
    logs.push(...(await requestBackfillRangeAdaptive(requester, padAddress, chunkFrom, chunkTo)));
  }
  const unique = new Map<string, RpcContractLog>();
  for (const log of logs) {
    unique.set(`${log.transactionHash.toLowerCase()}:${log.logIndex.toString()}`, log);
  }
  return Object.freeze(
    [...unique.values()].sort((left, right) => {
      if (left.blockNumber !== right.blockNumber) {
        return left.blockNumber < right.blockNumber ? -1 : 1;
      }
      return left.logIndex < right.logIndex ? -1 : left.logIndex > right.logIndex ? 1 : 0;
    }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameArmed(left: StonkSafeLaunchQuotedArmed, right: StonkSafeLaunchQuotedArmed): boolean {
  return (
    left.id === right.id &&
    left.supply === right.supply &&
    left.virtualQuoteInitial === right.virtualQuoteInitial &&
    left.quoteUsd8 === right.quoteUsd8 &&
    left.deadline === right.deadline
  );
}

export async function discoverStonkSafeLaunchClockIn(
  options: StonkSafeLaunchDiscoveryOptions,
): Promise<StonkSafeLaunchDiscoveryResult> {
  if (options.profile !== undefined && options.padAddress !== undefined) {
    throw new Error("set Safe Launch profile or padAddress, not both");
  }
  const profile =
    options.profile ??
    Object.freeze({
      ...CLOCKIN_WETH_SAFE_LAUNCH_PROFILE,
      factoryAddress: getAddress(
        options.padAddress ?? CLOCKIN_WETH_SAFE_LAUNCH_PROFILE.factoryAddress,
      ) as Hex,
    });
  const padAddress = getAddress(profile.factoryAddress) as Hex;
  const initialHead = await latestBlock(options.requester);
  const startBlock = options.startBlock ?? initialHead;
  if (startBlock < 0n)
    throw new RangeError("Safe Launch discovery startBlock must not be negative");
  await options.onEvent?.({ kind: "ARMED", padAddress, startBlock, currentBlock: initialHead });
  const backfillChunkSize = options.backfillChunkSize ?? DEFAULT_BACKFILL_CHUNK_SIZE;
  if (backfillChunkSize < 1n) throw new RangeError("backfillChunkSize must be positive");
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isAborted = (): boolean => options.signal?.aborted ?? false;

  let cursor = startBlock;
  let reconnectAttempt = 0;
  let finished = false;
  let bound: BoundCandidate | null = null;
  const metadataById = new Map<string, StonkSafeLaunchTokenMetadata>();
  const rejectedIds = new Set<string>();
  const armedById = new Map<string, ObservedArmed>();
  const seen = new Set<string>();
  let activeSubscriptions: readonly ContractLogSubscription[] = Object.freeze([]);
  let queue = Promise.resolve();
  let resolveResult!: (result: StonkSafeLaunchDiscoveryResult) => void;
  let rejectResult!: (error: Error) => void;
  const resultPromise = new Promise<StonkSafeLaunchDiscoveryResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const closeSubscriptions = (): void => {
    for (const subscription of activeSubscriptions) subscription.close();
    activeSubscriptions = Object.freeze([]);
  };
  const fail = (error: unknown): void => {
    if (finished) return;
    finished = true;
    closeSubscriptions();
    rejectResult(error instanceof Error ? error : new Error(String(error)));
  };
  const succeed = (candidate: BoundCandidate, observed: ObservedArmed): void => {
    if (finished) return;
    finished = true;
    closeSubscriptions();
    resolveResult(
      Object.freeze({
        created: candidate.created,
        armed: observed.armed,
        metadata: metadataById.get(candidate.created.id.toString()) ?? null,
        createdSource: candidate.source,
        armedSource: observed.source,
      }),
    );
  };
  const processLog = async (
    log: RpcContractLog,
    source: StonkSafeLaunchDiscoverySource,
  ): Promise<void> => {
    if (finished || log.blockNumber < startBlock) return;
    if (log.removed) {
      throw new CanonicalInvariantError("REORG_DETECTED", "removed Safe Launch log observed");
    }
    const key = `${log.transactionHash.toLowerCase()}:${log.logIndex.toString()}`;
    if (seen.has(key)) return;

    const topic0 = log.topics[0]?.toLowerCase();
    if (topic0 === STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC.toLowerCase()) {
      const created = decodeStonkSafeLaunchQuotedCreated(log, profile);
      const idKey = created.id.toString();
      if (
        options.expectedCreated !== undefined &&
        !matchesExpectedCreated(created, options.expectedCreated)
      ) {
        seen.add(key);
        await options.onEvent?.({
          kind: "CANDIDATE_REJECTED",
          launchId: created.id,
          tokenAddress: created.tokenAddress,
          transactionHash: created.transactionHash,
          reasons: Object.freeze(["not the exact public LaunchCreated handoff"]),
        });
        return;
      }
      if (created.creatorAddress.toLowerCase() !== CLOCKIN_APPROVED_LAUNCH_CREATOR.toLowerCase()) {
        rejectedIds.add(idKey);
        seen.add(key);
        await options.onEvent?.({
          kind: "CANDIDATE_REJECTED",
          launchId: created.id,
          tokenAddress: created.tokenAddress,
          transactionHash: created.transactionHash,
          reasons: Object.freeze(["creator is not the approved ClockIn launch wallet"]),
        });
        return;
      }

      if (bound !== null) {
        throw new CanonicalInvariantError(
          "IDENTITY_CONFLICT",
          "multiple distinct approved ClockIn Safe Launch candidates observed",
        );
      }
      bound = Object.freeze({ created, source });
      seen.add(key);
      await options.onEvent?.({
        kind: "CANDIDATE_BOUND",
        launchId: created.id,
        tokenAddress: created.tokenAddress,
        blockNumber: created.blockNumber,
      });
      void readTokenMetadata(options.requester, created.tokenAddress, created.blockNumber)
        .then(async (metadata) => {
          metadataById.set(idKey, metadata);
          await options.onEvent?.({
            kind: "METADATA_OBSERVED",
            launchId: created.id,
            tokenAddress: created.tokenAddress,
            metadata,
          });
        })
        .catch(async (error: unknown) => {
          try {
            await options.onEvent?.({
              kind: "METADATA_UNAVAILABLE",
              launchId: created.id,
              tokenAddress: created.tokenAddress,
              metadata: null,
              message: errorMessage(error),
            });
          } catch {
            // Metadata audit is deliberately unable to fail creator-first discovery.
          }
        });
      const pendingArmed = armedById.get(idKey);
      if (pendingArmed !== undefined) succeed(bound, pendingArmed);
      return;
    }

    if (topic0 === STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC.toLowerCase()) {
      const armed = decodeStonkSafeLaunchQuotedArmed(log, profile);
      const idKey = armed.id.toString();
      if (
        options.expectedCreated !== undefined &&
        armed.id !== BigInt(options.expectedCreated.launchId)
      ) {
        seen.add(key);
        return;
      }
      if (rejectedIds.has(idKey)) {
        seen.add(key);
        return;
      }
      const previous = armedById.get(idKey);
      if (previous !== undefined && !sameArmed(previous.armed, armed)) {
        throw new CanonicalInvariantError(
          "IDENTITY_CONFLICT",
          `conflicting LaunchArmed payloads observed for launch ${idKey}`,
        );
      }
      if (previous === undefined) armedById.set(idKey, Object.freeze({ armed, source }));
      seen.add(key);
      if (bound !== null && bound.created.id === armed.id) {
        succeed(bound, armedById.get(idKey) ?? Object.freeze({ armed, source }));
      }
      return;
    }

    throw new CanonicalInvariantError(
      "IDENTITY_CONFLICT",
      "quoted-pad subscription delivered an unexpected event topic",
    );
  };

  const enqueue = (log: RpcContractLog, source: StonkSafeLaunchDiscoverySource): void => {
    queue = queue.then(() => processLog(log, source)).catch((error: unknown) => fail(error));
  };

  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (options.signal === undefined) return;
    const abort = (): void => reject(new Error("Safe Launch discovery aborted"));
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  });
  while (!finished) {
    if (isAborted()) {
      closeSubscriptions();
      throw new Error("Safe Launch discovery aborted");
    }
    try {
      const subscribe =
        options.logsClientFactory ??
        ((topic0: Hex, onLog: (log: RpcContractLog) => void) =>
          new WebSocketContractLogsClient({
            providerId: `${options.requester.providerId}-safe-launch-logs`,
            url: options.wssUrl,
            address: padAddress,
            topic0,
            setupTimeoutMs: 8_000,
          }).subscribe(onLog));
      const subscriptions = await Promise.all([
        subscribe(STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC, (log) => enqueue(log, "WSS")),
        subscribe(STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC, (log) => enqueue(log, "WSS")),
      ]);
      activeSubscriptions = Object.freeze(subscriptions);

      const head = await latestBlock(options.requester);
      await options.onEvent?.({ kind: "BACKFILL", fromBlock: cursor, toBlock: head });
      for (const log of await backfill(
        options.requester,
        padAddress,
        cursor,
        head,
        backfillChunkSize,
      )) {
        enqueue(log, "BACKFILL");
      }
      if (head > cursor) cursor = head;
      await queue;
      if (finished) return await resultPromise;
      reconnectAttempt = 0;

      const subscriptionEnded = Promise.race(
        subscriptions.map((subscription) => subscription.done),
      );
      const recovery = await Promise.race([
        resultPromise.then(() => null),
        subscriptionEnded.then(
          () => new Error("Safe Launch log subscription ended before matching LaunchArmed"),
        ),
        abortPromise,
      ]);
      if (finished) return await resultPromise;
      if (recovery instanceof Error) throw recovery;
      throw new Error("Safe Launch discovery ended without a result");
    } catch (error) {
      closeSubscriptions();
      if (finished) return await resultPromise;
      if (isAborted()) throw new Error("Safe Launch discovery aborted");
      reconnectAttempt += 1;
      await options.onEvent?.({
        kind: "WSS_RECONNECT",
        attempt: reconnectAttempt,
        message: errorMessage(error),
      });
      await sleep(Math.min(2_000, 100 * 2 ** Math.min(reconnectAttempt, 4)));
    }
  }
  return resultPromise;
}
