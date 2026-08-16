import { evaluateClockInIdentity } from "../identity/identity-binder.js";
import { hexToBigInt, quantityToHex } from "../rpc/hex.js";
import {
  parseRpcContractLog,
  WebSocketContractLogsClient,
  type ContractLogSubscription,
  type RawRpcContractLog,
  type RpcContractLog,
} from "../rpc/websocket-logs.js";
import type { JsonRpcRequester } from "../rpc/types.js";
import {
  decodeConfiguredLaunchLog,
  verifyConfiguredCodeIdentity,
} from "../adapters/configured-launcher.js";
import type { LaunchCandidate } from "../core/canonical.js";
import type { ProductionProtocolProfile } from "./production-profile.js";
import { readProductionReceipt } from "./production-rpc.js";

export type ConfiguredDiscoveryEvent =
  | Readonly<{ kind: "ARMED"; startBlock: bigint; currentBlock: bigint }>
  | Readonly<{
      kind: "CANDIDATE_REJECTED";
      transactionHash: `0x${string}`;
      reasons: readonly string[];
    }>
  | Readonly<{ kind: "BACKFILL"; fromBlock: bigint; toBlock: bigint }>
  | Readonly<{ kind: "WSS_RECONNECT"; attempt: number; message: string }>;

export interface ConfiguredDiscoveryResult {
  readonly candidate: LaunchCandidate;
  readonly log: RpcContractLog;
  readonly source: "WSS" | "BACKFILL";
}

export interface ConfiguredDiscoveryOptions {
  readonly requester: JsonRpcRequester;
  readonly wssUrl: string;
  readonly profile: ProductionProtocolProfile;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ConfiguredDiscoveryEvent) => void | Promise<void>;
  readonly logsClientFactory?: (
    onLog: (log: RpcContractLog) => void,
  ) => Promise<ContractLogSubscription>;
  readonly sleep?: (ms: number) => Promise<void>;
}

async function latestBlock(requester: JsonRpcRequester): Promise<bigint> {
  return hexToBigInt("eth_blockNumber", await requester.request<string>("eth_blockNumber"));
}

async function backfill(
  requester: JsonRpcRequester,
  profile: ProductionProtocolProfile,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<readonly RpcContractLog[]> {
  if (toBlock < fromBlock) return Object.freeze([]);
  const raw = await requester.request<readonly RawRpcContractLog[]>("eth_getLogs", [
    {
      address: profile.factory.address,
      topics: [profile.factory.launchEventTopic],
      fromBlock: quantityToHex(fromBlock),
      toBlock: quantityToHex(toBlock),
    },
  ]);
  return Object.freeze(
    raw
      .map((log) => parseRpcContractLog(requester.providerId, log))
      .sort((left, right) => {
        if (left.blockNumber !== right.blockNumber)
          return left.blockNumber < right.blockNumber ? -1 : 1;
        return left.logIndex < right.logIndex ? -1 : left.logIndex > right.logIndex ? 1 : 0;
      }),
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function discoverConfiguredClockInLaunch(
  options: ConfiguredDiscoveryOptions,
): Promise<ConfiguredDiscoveryResult> {
  await verifyConfiguredCodeIdentity({
    requester: options.requester,
    profile: options.profile,
    blockNumber: "latest",
  });
  const deploymentBlock = BigInt(options.profile.factory.startBlock);
  const initialHead = await latestBlock(options.requester);
  const startBlock = deploymentBlock > initialHead ? initialHead : deploymentBlock;
  await options.onEvent?.({ kind: "ARMED", startBlock, currentBlock: initialHead });

  const seen = new Set<string>();
  let cursor = startBlock;
  let reconnectAttempt = 0;
  let activeSubscription: ContractLogSubscription | null = null;
  let settled = false;
  let fatalError: Error | null = null;
  let queue = Promise.resolve();
  let resolveResult!: (result: ConfiguredDiscoveryResult) => void;
  let rejectResult!: (error: Error) => void;
  const resultPromise = new Promise<ConfiguredDiscoveryResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const policy = Object.freeze({
    expectedNames: Object.freeze([options.profile.identity.expectedName]),
    expectedSymbols: Object.freeze([options.profile.identity.expectedSymbol]),
    expectedCreators: Object.freeze(
      options.profile.identity.expectedCreator === undefined
        ? []
        : [options.profile.identity.expectedCreator],
    ),
    metadataIncludes: Object.freeze(
      options.profile.identity.metadataIncludes === undefined
        ? []
        : [options.profile.identity.metadataIncludes],
    ),
    tokenSuffixes: Object.freeze(
      options.profile.identity.requiredTokenSuffix === undefined
        ? []
        : [options.profile.identity.requiredTokenSuffix],
    ),
    requireCreator: options.profile.identity.expectedCreator !== undefined,
    requireMetadata: options.profile.identity.metadataIncludes !== undefined,
    requireTokenSuffix: options.profile.identity.requiredTokenSuffix !== undefined,
    policyRevision: options.profile.revision,
  });

  const consume = (log: RpcContractLog, source: ConfiguredDiscoveryResult["source"]): void => {
    if (settled || log.removed || log.blockNumber < startBlock) return;
    const key = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
    if (seen.has(key)) return;
    seen.add(key);
    queue = queue
      .then(async () => {
        if (settled) return;
        const receipt = await readProductionReceipt(options.requester, log.transactionHash);
        if (receipt === null) throw new Error("launch receipt is not yet readable");
        const observedAt = new Date().toISOString();
        const evidenceId = `launch-log:${log.transactionHash}:${log.logIndex}`;
        const candidate = decodeConfiguredLaunchLog({
          log,
          profile: options.profile,
          blockHash: receipt.blockHash,
          transactionIndex: receipt.transactionIndex,
          observedAt,
          evidenceIds: [evidenceId, `profile:${options.profile.profileHash}`],
        });
        const evaluation = evaluateClockInIdentity(candidate, policy);
        if (!evaluation.clockInBound) {
          await options.onEvent?.({
            kind: "CANDIDATE_REJECTED",
            transactionHash: log.transactionHash,
            reasons: evaluation.reasons,
          });
          return;
        }
        settled = true;
        activeSubscription?.close();
        resolveResult(Object.freeze({ candidate, log, source }));
      })
      .catch((error: unknown) => {
        seen.delete(key);
        if (!settled) {
          fatalError = error instanceof Error ? error : new Error(String(error));
          rejectResult(fatalError);
        }
      });
  };

  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (options.signal === undefined) return;
    const abort = (): void => reject(new Error("configured Factory discovery aborted"));
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  });
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isAborted = (): boolean => options.signal?.aborted ?? false;

  while (!settled) {
    if (isAborted()) throw new Error("configured Factory discovery aborted");
    try {
      const subscribe =
        options.logsClientFactory ??
        ((onLog: (log: RpcContractLog) => void) =>
          new WebSocketContractLogsClient({
            providerId: `${options.requester.providerId}-factory-logs`,
            url: options.wssUrl,
            address: options.profile.factory.address,
            topic0: options.profile.factory.launchEventTopic,
            setupTimeoutMs: 8_000,
          }).subscribe(onLog));
      activeSubscription = await subscribe((log) => consume(log, "WSS"));
      reconnectAttempt = 0;
      const head = await latestBlock(options.requester);
      await options.onEvent?.({ kind: "BACKFILL", fromBlock: cursor, toBlock: head });
      for (const log of await backfill(options.requester, options.profile, cursor, head)) {
        consume(log, "BACKFILL");
      }
      cursor = head > cursor ? head : cursor;
      await queue;
      if (settled) return await resultPromise;
      await Promise.race([resultPromise, activeSubscription.done, abortPromise]);
      if (settled) return await resultPromise;
      throw new Error("Factory log subscription ended without a ClockIn candidate");
    } catch (error) {
      activeSubscription?.close();
      activeSubscription = null;
      if (settled) return await resultPromise;
      if (fatalError !== null) throw fatalError;
      if (isAborted()) throw new Error("configured Factory discovery aborted");
      reconnectAttempt += 1;
      await options.onEvent?.({
        kind: "WSS_RECONNECT",
        attempt: reconnectAttempt,
        message: message(error),
      });
      await sleep(Math.min(2_000, 100 * 2 ** Math.min(reconnectAttempt, 4)));
    }
  }
  return resultPromise;
}
