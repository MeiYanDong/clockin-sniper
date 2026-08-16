import { getAddress } from "ethers";

import {
  decodeTokenLaunchedLog,
  evaluateLaunchIdentity,
  runtimeCodeHash,
  TOKEN_LAUNCHED_TOPIC,
  type LaunchIdentityPolicy,
  type StonkLaunchCandidate,
} from "./stonk-launcher.js";
import { assertHex, hexToBigInt, quantityToHex } from "./rpc/hex.js";
import {
  parseRpcContractLog,
  WebSocketContractLogsClient,
  type ContractLogSubscription,
  type RawRpcContractLog,
  type RpcContractLog,
} from "./rpc/websocket-logs.js";
import type { Hex, JsonRpcRequester } from "./rpc/types.js";

export type DiscoveryEvent =
  | {
      readonly kind: "armed";
      readonly startBlock: bigint;
      readonly factoryCodeHash: Hex;
    }
  | {
      readonly kind: "candidate_rejected";
      readonly transactionHash: Hex;
      readonly reasons: readonly string[];
    }
  | { readonly kind: "wss_reconnect"; readonly attempt: number; readonly message: string }
  | { readonly kind: "backfill"; readonly fromBlock: bigint; readonly toBlock: bigint };

export interface FactoryDiscoveryOptions {
  readonly requester: JsonRpcRequester;
  readonly wsRpcUrl: string;
  readonly providerId: string;
  readonly identityPolicy: LaunchIdentityPolicy;
  readonly expectedFactoryCodeHash: Hex;
  readonly startBlock?: bigint;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: DiscoveryEvent) => void | Promise<void>;
  readonly logsClientFactory?: (
    onLog: (log: RpcContractLog) => void,
  ) => Promise<ContractLogSubscription>;
  readonly sleep?: (ms: number) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function emit(
  onEvent: FactoryDiscoveryOptions["onEvent"],
  event: DiscoveryEvent,
): Promise<void> {
  await onEvent?.(event);
}

export async function verifyFactoryRuntimeCode(
  requester: JsonRpcRequester,
  factoryAddress: Hex,
  expectedCodeHash: Hex,
  blockTag: string = "latest",
): Promise<Hex> {
  assertHex("expectedFactoryCodeHash", expectedCodeHash);
  if (expectedCodeHash.length !== 66) {
    throw new RangeError("expectedFactoryCodeHash must be 32 bytes");
  }
  const code = await requester.request<string>("eth_getCode", [factoryAddress, blockTag]);
  const actual = runtimeCodeHash(code);
  if (actual.toLowerCase() !== expectedCodeHash.toLowerCase()) {
    throw new Error(
      `Factory runtime code hash mismatch: expected ${expectedCodeHash}, got ${actual}`,
    );
  }
  return actual;
}

async function readLatestBlock(requester: JsonRpcRequester): Promise<bigint> {
  return hexToBigInt("eth_blockNumber", await requester.request<string>("eth_blockNumber"));
}

async function backfillLogs(
  requester: JsonRpcRequester,
  policy: LaunchIdentityPolicy,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<readonly RpcContractLog[]> {
  if (toBlock < fromBlock) return [];
  const raw = await requester.request<readonly RawRpcContractLog[]>("eth_getLogs", [
    {
      address: policy.factoryAddress,
      topics: [TOKEN_LAUNCHED_TOPIC],
      fromBlock: quantityToHex(fromBlock),
      toBlock: quantityToHex(toBlock),
    },
  ]);
  return Object.freeze(
    raw
      .map((entry) => parseRpcContractLog(requester.providerId, entry))
      .sort((left, right) => {
        if (left.blockNumber !== right.blockNumber) {
          return left.blockNumber < right.blockNumber ? -1 : 1;
        }
        return left.logIndex < right.logIndex ? -1 : left.logIndex > right.logIndex ? 1 : 0;
      }),
  );
}

/**
 * Arms at the current block, subscribes before backfilling that boundary, and
 * freezes the first identity-valid event. Reconnects backfill the last seen
 * block so a disconnect cannot silently skip a launch.
 */
export async function discoverClockInLaunch(
  options: FactoryDiscoveryOptions,
): Promise<StonkLaunchCandidate> {
  const policy: LaunchIdentityPolicy = Object.freeze({
    ...options.identityPolicy,
    factoryAddress: getAddress(options.identityPolicy.factoryAddress) as Hex,
  });
  const codeHash = await verifyFactoryRuntimeCode(
    options.requester,
    policy.factoryAddress,
    options.expectedFactoryCodeHash,
  );
  const startBlock = options.startBlock ?? (await readLatestBlock(options.requester));
  if (startBlock < 0n) throw new RangeError("discovery startBlock must not be negative");
  await emit(options.onEvent, { kind: "armed", startBlock, factoryCodeHash: codeHash });

  const seen = new Set<string>();
  let cursor = startBlock;
  let reconnectAttempt = 0;
  let activeSubscription: ContractLogSubscription | null = null;
  let settled = false;
  let resolveCandidate!: (candidate: StonkLaunchCandidate) => void;
  const candidatePromise = new Promise<StonkLaunchCandidate>((resolve) => {
    resolveCandidate = resolve;
  });

  const consume = (log: RpcContractLog, source: StonkLaunchCandidate["source"]): void => {
    if (settled || log.removed || log.blockNumber < startBlock) return;
    cursor = log.blockNumber > cursor ? log.blockNumber : cursor;
    const key = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
    if (seen.has(key)) return;
    seen.add(key);

    let candidate: StonkLaunchCandidate;
    try {
      candidate = decodeTokenLaunchedLog(log, source);
    } catch {
      return;
    }
    const evaluation = evaluateLaunchIdentity(candidate, policy);
    if (!evaluation.accepted) {
      void emit(options.onEvent, {
        kind: "candidate_rejected",
        transactionHash: candidate.transactionHash,
        reasons: evaluation.reasons,
      });
      return;
    }
    settled = true;
    activeSubscription?.close();
    resolveCandidate(Object.freeze(candidate));
  };

  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (options.signal === undefined) return;
    const abort = (): void => reject(new Error("Factory discovery aborted"));
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  });
  const isAborted = (): boolean => options.signal?.aborted ?? false;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  while (!settled) {
    if (isAborted()) throw new Error("Factory discovery aborted");
    try {
      const subscribe =
        options.logsClientFactory ??
        ((onLog: (log: RpcContractLog) => void) =>
          new WebSocketContractLogsClient({
            providerId: options.providerId,
            url: options.wsRpcUrl,
            address: policy.factoryAddress,
            topic0: TOKEN_LAUNCHED_TOPIC,
          }).subscribe(onLog));
      activeSubscription = await subscribe((log) => consume(log, "wss"));
      reconnectAttempt = 0;

      const latest = await readLatestBlock(options.requester);
      await emit(options.onEvent, { kind: "backfill", fromBlock: cursor, toBlock: latest });
      for (const log of await backfillLogs(options.requester, policy, cursor, latest)) {
        consume(log, "backfill");
        if (settled) break;
      }
      cursor = latest > cursor ? latest : cursor;
      if (settled) return await candidatePromise;

      await Promise.race([candidatePromise, activeSubscription.done, abortPromise]);
      if (settled) return await candidatePromise;
      throw new Error("Factory log subscription ended without a candidate");
    } catch (error) {
      activeSubscription?.close();
      activeSubscription = null;
      if (settled) return await candidatePromise;
      if (isAborted()) throw new Error("Factory discovery aborted");
      reconnectAttempt += 1;
      await emit(options.onEvent, {
        kind: "wss_reconnect",
        attempt: reconnectAttempt,
        message: errorMessage(error),
      });
      await sleep(Math.min(1_000, 50 * 2 ** Math.min(reconnectAttempt, 4)));
    }
  }

  return candidatePromise;
}
