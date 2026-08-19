import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Interface, toBeHex, zeroPadValue } from "ethers";

import {
  CLOCKIN_APPROVED_LAUNCH_CREATOR,
  STONK_SAFE_LAUNCH_QUOTED_ARMED_EVENT_ABI,
  STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
  STONK_SAFE_LAUNCH_QUOTED_CREATED_EVENT_ABI,
  STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
  STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
} from "../src/adapters/stonk-safe-launch-quoted.js";
import { PublicSafeLaunchHandoffProducer } from "../src/control/public-safe-launch-handoff.js";
import type { Hex, JsonRpcRequester } from "../src/rpc/types.js";
import type { RawRpcContractLog } from "../src/rpc/websocket-logs.js";
import {
  PUBLIC_LAUNCH_HANDOFF_ACTIVE_SIGNAL_FILENAME,
  PUBLIC_LAUNCH_HANDOFF_CURRENT_FILENAME,
  PUBLIC_LAUNCH_HANDOFF_CURSOR_FILENAME,
  PUBLIC_LAUNCH_HANDOFF_INVALIDATIONS_DIRECTORY,
  PUBLIC_LAUNCH_HANDOFF_PROFILE_HASH,
  PUBLIC_LAUNCH_HANDOFF_RECORDS_DIRECTORY,
  PublicLaunchHandoffStore,
  readCurrentPublicLaunchHandoff,
} from "../src/runtime/public-launch-handoff.js";

const events = new Interface([
  STONK_SAFE_LAUNCH_QUOTED_CREATED_EVENT_ABI,
  STONK_SAFE_LAUNCH_QUOTED_ARMED_EVENT_ABI,
]);
const metadata = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
const BLOCK_HASH_A = `0x${"aa".repeat(32)}` as Hex;
const BLOCK_HASH_B = `0x${"bb".repeat(32)}` as Hex;

function rawCreated(
  input: {
    readonly id?: bigint;
    readonly token?: string;
    readonly creator?: string;
    readonly externalToken?: boolean;
    readonly block?: bigint;
    readonly logIndex?: bigint;
    readonly transactionHash?: Hex;
  } = {},
): RawRpcContractLog {
  const id = input.id ?? 7n;
  const token = input.token ?? "0x1111111111111111111111111111111111111111";
  const creator = input.creator ?? CLOCKIN_APPROVED_LAUNCH_CREATOR;
  const encoded = events.encodeEventLog("LaunchCreated", [
    id,
    token,
    creator,
    input.externalToken ?? false,
  ]);
  const block = input.block ?? 100n;
  return Object.freeze({
    address: STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash:
      input.transactionHash ?? (`0x${(id + 100n).toString(16).padStart(64, "0")}` as Hex),
    logIndex: `0x${(input.logIndex ?? 0n).toString(16)}`,
    removed: false,
  });
}

function rawArmed(
  input: {
    readonly id?: bigint;
    readonly block?: bigint;
    readonly logIndex?: bigint;
    readonly transactionHash?: Hex;
  } = {},
): RawRpcContractLog {
  const id = input.id ?? 7n;
  const encoded = events.encodeEventLog("LaunchArmed", [
    id,
    1_000_000n,
    5_000n,
    200_000_000_000n,
    2_500n,
  ]);
  const block = input.block ?? 101n;
  return Object.freeze({
    address: STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash:
      input.transactionHash ?? (`0x${(id + 200n).toString(16).padStart(64, "0")}` as Hex),
    logIndex: `0x${(input.logIndex ?? 0n).toString(16)}`,
    removed: false,
  });
}

class FakePublicRpc implements JsonRpcRequester {
  readonly providerId = "robinhood-public-http";
  readonly calls: Array<{ method: string; params: readonly unknown[] }> = [];
  results: readonly RawRpcContractLog[] = [];
  error: Error | null = null;
  metadataFailuresRemaining = 0;
  invalidMetadataResponsesRemaining = 0;
  blockFailuresRemaining = 0;
  readonly getLogsFailuresByFromBlock = new Map<string, number>();
  readonly tokenMetadata = new Map<string, Readonly<{ name: string; symbol: string }>>();
  readonly canonicalBlockHashes = new Map<bigint, Hex>();

  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    this.calls.push({ method, params });
    if (this.error !== null) throw this.error;
    if (method === "eth_getLogs") {
      const filter = params[0] as {
        readonly topics?: readonly unknown[];
        readonly fromBlock?: string;
      };
      const failureKey = filter.fromBlock ?? "";
      const failuresRemaining = this.getLogsFailuresByFromBlock.get(failureKey) ?? 0;
      if (failuresRemaining > 0) {
        this.getLogsFailuresByFromBlock.set(failureKey, failuresRemaining - 1);
        throw new Error("HTTP 503 in historical chunk");
      }
      const topic0 = filter.topics?.[0];
      const topic1 = filter.topics?.[1];
      return this.results.filter((log) => {
        const logTopics = Array.isArray(log.topics) ? log.topics : [];
        if (
          typeof topic0 === "string" &&
          (typeof logTopics[0] !== "string" || logTopics[0].toLowerCase() !== topic0.toLowerCase())
        ) {
          return false;
        }
        if (
          typeof topic1 === "string" &&
          (typeof logTopics[1] !== "string" || logTopics[1].toLowerCase() !== topic1.toLowerCase())
        ) {
          return false;
        }
        return true;
      }) as T;
    }
    if (method === "eth_getTransactionReceipt") {
      const transactionHash = params[0];
      const log = this.results.find(
        (candidate) =>
          typeof candidate.transactionHash === "string" &&
          typeof transactionHash === "string" &&
          candidate.transactionHash.toLowerCase() === transactionHash.toLowerCase(),
      );
      if (log === undefined || typeof log.blockNumber !== "string") return null as T;
      const blockNumber = BigInt(log.blockNumber);
      return {
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        blockHash: this.canonicalBlockHashes.get(blockNumber) ?? BLOCK_HASH_A,
        status: "0x1",
        logs: [log],
      } as T;
    }
    if (method === "eth_getBlockByNumber") {
      if (this.blockFailuresRemaining > 0) {
        this.blockFailuresRemaining -= 1;
        throw new Error("canonical block temporarily unavailable");
      }
      if (typeof params[0] !== "string") throw new Error("invalid block fixture");
      const blockNumber = BigInt(params[0]);
      return {
        number: params[0],
        hash: this.canonicalBlockHashes.get(blockNumber) ?? BLOCK_HASH_A,
      } as T;
    }
    if (method !== "eth_call") throw new Error(`unexpected public RPC method ${method}`);
    if (this.metadataFailuresRemaining > 0) {
      this.metadataFailuresRemaining -= 1;
      throw new Error("metadata temporarily unavailable");
    }
    if (this.invalidMetadataResponsesRemaining > 0) {
      this.invalidMetadataResponsesRemaining -= 1;
      return "0x1234" as T;
    }
    const call = params[0] as { readonly to?: string; readonly data?: string };
    if (typeof call.to !== "string" || typeof call.data !== "string") {
      throw new Error("invalid metadata eth_call fixture");
    }
    const values = this.tokenMetadata.get(call.to.toLowerCase()) ?? {
      name: "Clock In",
      symbol: "CLOCKIN",
    };
    const fragment = metadata.getFunction(call.data.slice(0, 10));
    if (fragment === null || (fragment.name !== "name" && fragment.name !== "symbol")) {
      throw new Error("unexpected metadata selector");
    }
    return metadata.encodeFunctionResult(fragment, [values[fragment.name]]) as T;
  }
}

function publicProducer(
  options: ConstructorParameters<typeof PublicSafeLaunchHandoffProducer>[0],
): PublicSafeLaunchHandoffProducer {
  return new PublicSafeLaunchHandoffProducer({ confirmationDepth: 0n, ...options });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clockin-public-handoff-"));
  await chmod(directory, 0o2750);
  return directory;
}

describe("public Safe Launch handoff producer", () => {
  it("uses the exact WETH pad/topic/creator filter and publishes only after exact-block metadata", async () => {
    const directory = await temporaryDirectory();
    try {
      const rpc = new FakePublicRpc();
      rpc.results = [rawCreated()];
      const producer = publicProducer({
        requester: rpc,
        directory,
        initialCursor: 99n,
        now: () => "2026-08-20T00:00:00.000Z",
      });
      const result = await producer.scanToHead(100n);

      assert.deepEqual(result, {
        fromBlock: 100n,
        toBlock: 100n,
        queriedChunks: 1,
        matchingLogs: 1,
        created: 1,
        duplicates: 0,
        armedSignals: 0,
      });
      assert.equal(rpc.calls.length, 7);
      const filter = (rpc.calls[0]?.params[0] ?? {}) as {
        readonly address?: string;
        readonly topics?: readonly unknown[];
        readonly fromBlock?: string;
        readonly toBlock?: string;
      };
      assert.equal(filter.address, STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS);
      assert.deepEqual(filter.topics, [
        STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
        null,
        null,
        zeroPadValue(CLOCKIN_APPROVED_LAUNCH_CREATOR, 32),
      ]);
      assert.equal(filter.fromBlock, "0x64");
      assert.equal(filter.toBlock, "0x64");
      assert.deepEqual(
        rpc.calls.filter((call) => call.method === "eth_call").map((call) => call.params[1]),
        ["0x64", "0x64"],
      );
      const handoff = await readCurrentPublicLaunchHandoff(directory);
      assert.equal(handoff?.profileHash, PUBLIC_LAUNCH_HANDOFF_PROFILE_HASH);
      assert.equal(handoff?.created.launchId, "7");
      assert.equal(handoff?.created.tokenAddress, "0x1111111111111111111111111111111111111111");
      assert.equal(handoff?.created.externalToken, false);
      assert.equal(handoff?.created.blockHash, BLOCK_HASH_A);
      assert.equal(producer.snapshot().cursor, "100");
      assert.equal(producer.snapshot().confirmedHead, "100");
      assert.equal(producer.snapshot().cursorLagBlocks, "0");
      assert.equal(producer.snapshot().caughtUp, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("caps every range at 2000 blocks", async () => {
    const directory = await temporaryDirectory();
    try {
      const rpc = new FakePublicRpc();
      const producer = publicProducer({
        requester: rpc,
        directory,
        initialCursor: 0n,
      });
      const result = await producer.scanToHead(4_001n);
      assert.equal(result.queriedChunks, 3);
      assert.deepEqual(
        rpc.calls.map((call) => call.params[0]),
        [
          {
            address: STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
            topics: [
              STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
              null,
              null,
              zeroPadValue(CLOCKIN_APPROVED_LAUNCH_CREATOR, 32),
            ],
            fromBlock: "0x1",
            toBlock: "0x7d0",
          },
          {
            address: STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
            topics: [
              STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
              null,
              null,
              zeroPadValue(CLOCKIN_APPROVED_LAUNCH_CREATOR, 32),
            ],
            fromBlock: "0x7d1",
            toBlock: "0xfa0",
          },
          {
            address: STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
            topics: [
              STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
              null,
              null,
              zeroPadValue(CLOCKIN_APPROVED_LAUNCH_CREATOR, 32),
            ],
            fromBlock: "0xfa1",
            toBlock: "0xfa1",
          },
        ],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a same-creator non-CLOCKIN launch and accepts a later exact metadata match", async () => {
    const directory = await temporaryDirectory();
    try {
      const firstToken = "0x1111111111111111111111111111111111111111";
      const secondToken = "0x2222222222222222222222222222222222222222";
      const rpc = new FakePublicRpc();
      rpc.results = [
        rawCreated({ id: 7n, token: firstToken, logIndex: 0n }),
        rawCreated({ id: 8n, token: secondToken, logIndex: 1n }),
      ];
      rpc.tokenMetadata.set(firstToken.toLowerCase(), {
        name: "Not Clock In",
        symbol: "OTHER",
      });
      rpc.tokenMetadata.set(secondToken.toLowerCase(), {
        name: "Clock In",
        symbol: "CLOCKIN",
      });
      const producer = publicProducer({
        requester: rpc,
        directory,
        initialCursor: 99n,
        now: () => "2026-08-20T00:00:00.000Z",
      });

      const result = await producer.scanToHead(100n);
      assert.equal(result.matchingLogs, 2);
      assert.equal(result.created, 1);
      assert.equal((await readCurrentPublicLaunchHandoff(directory))?.created.launchId, "8");
      assert.equal(
        (await readCurrentPublicLaunchHandoff(directory))?.created.tokenAddress,
        secondToken,
      );
      assert.equal(producer.snapshot().cursor, "100");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries the same chunk after transient or invalid metadata without advancing cursor", async () => {
    const directory = await temporaryDirectory();
    try {
      const rpc = new FakePublicRpc();
      rpc.results = [rawCreated()];
      rpc.metadataFailuresRemaining = 1;
      const producer = publicProducer({
        requester: rpc,
        directory,
        initialCursor: 99n,
      });

      await assert.rejects(() => producer.scanToHead(100n), /metadata temporarily unavailable/u);
      assert.equal(producer.snapshot().cursor, "99");
      assert.equal(await readCurrentPublicLaunchHandoff(directory), null);
      assert.equal(await new PublicLaunchHandoffStore(directory).readCursor(), null);

      rpc.invalidMetadataResponsesRemaining = 1;
      await assert.rejects(() => producer.scanToHead(100n), /metadata name ABI decode failed/u);
      assert.equal(producer.snapshot().cursor, "99");
      assert.equal(await readCurrentPublicLaunchHandoff(directory), null);

      const retried = await producer.scanToHead(100n);
      assert.equal(retried.created, 1);
      assert.equal(producer.snapshot().cursor, "100");
      assert.equal((await readCurrentPublicLaunchHandoff(directory))?.created.launchId, "7");
      const logFilters = rpc.calls
        .filter((call) => call.method === "eth_getLogs")
        .map(
          (call) =>
            call.params[0] as { readonly fromBlock?: string; readonly topics?: readonly unknown[] },
        )
        .filter((filter) => filter.topics?.[0] === STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC);
      assert.deepEqual(
        logFilters.map((filter) => filter.fromBlock),
        ["0x64", "0x64", "0x64"],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not advance the durable cursor after a 503/timeout-style request failure", async () => {
    const directory = await temporaryDirectory();
    try {
      const rpc = new FakePublicRpc();
      rpc.error = new Error("HTTP 503");
      const producer = publicProducer({
        requester: rpc,
        directory,
        initialCursor: 99n,
      });
      await assert.rejects(() => producer.scanToHead(100n), /HTTP 503/u);
      assert.equal(producer.snapshot().cursor, "99");
      assert.equal(producer.snapshot().lastError, "HTTP 503");
      assert.equal(await new PublicLaunchHandoffStore(directory).readCursor(), null);

      rpc.error = null;
      await producer.scanToHead(100n);
      const filter = rpc.calls[1]?.params[0] as { readonly fromBlock?: string };
      assert.equal(filter.fromBlock, "0x64");
      assert.equal(producer.snapshot().cursor, "100");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("checkpoints every bounded chunk and resumes after a middle-range 503", async () => {
    const directory = await temporaryDirectory();
    try {
      const rpc = new FakePublicRpc();
      rpc.getLogsFailuresByFromBlock.set("0x7d1", 1);
      const producer = publicProducer({ requester: rpc, directory, initialCursor: 0n });

      await assert.rejects(() => producer.scanToHead(4_001n), /historical chunk/u);
      assert.equal(producer.snapshot().cursor, "2000");
      assert.equal(producer.snapshot().confirmedHead, "4001");
      assert.equal(producer.snapshot().cursorLagBlocks, "2001");
      assert.equal(producer.snapshot().caughtUp, false);
      assert.equal(
        (await new PublicLaunchHandoffStore(directory).readCursor())?.lastCompletedBlock,
        "2000",
      );

      const resumed = await producer.scanToHead(4_001n);
      assert.equal(resumed.fromBlock, 2_001n);
      assert.equal(resumed.queriedChunks, 2);
      assert.equal(producer.snapshot().cursor, "4001");
      assert.equal(producer.snapshot().cursorLagBlocks, "0");
      assert.equal(producer.snapshot().caughtUp, true);
      const ranges = rpc.calls
        .filter((call) => call.method === "eth_getLogs")
        .map((call) => (call.params[0] as { readonly fromBlock?: string }).fromBlock);
      assert.deepEqual(ranges, ["0x1", "0x7d1", "0x7d1", "0xfa1"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replays an immutable record after a cursor commit crash and deduplicates on restart", async () => {
    const directory = await temporaryDirectory();
    try {
      const rpc = new FakePublicRpc();
      rpc.results = [rawCreated()];
      const first = publicProducer({
        requester: rpc,
        directory,
        initialCursor: 99n,
        now: () => "2026-08-20T00:00:00.000Z",
      });
      await first.initialize();
      await mkdir(join(directory, PUBLIC_LAUNCH_HANDOFF_CURSOR_FILENAME));
      await assert.rejects(() => first.scanToHead(100n));
      assert.equal((await readCurrentPublicLaunchHandoff(directory))?.created.launchId, "7");

      await rm(join(directory, PUBLIC_LAUNCH_HANDOFF_CURSOR_FILENAME), { recursive: true });
      const second = publicProducer({
        requester: rpc,
        directory,
        initialCursor: 99n,
        now: () => "2026-08-20T00:00:01.000Z",
      });
      const replay = await second.scanToHead(100n);
      assert.equal(replay.created, 0);
      assert.equal(replay.duplicates, 1);
      assert.equal(second.snapshot().cursor, "100");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves the first pointer and fails closed on a second candidate conflict", async () => {
    const directory = await temporaryDirectory();
    try {
      const rpc = new FakePublicRpc();
      rpc.results = [
        rawCreated({ id: 7n, logIndex: 0n }),
        rawCreated({
          id: 8n,
          token: "0x2222222222222222222222222222222222222222",
          logIndex: 1n,
        }),
      ];
      const producer = publicProducer({
        requester: rpc,
        directory,
        initialCursor: 99n,
        now: () => "2026-08-20T00:00:00.000Z",
      });
      await assert.rejects(() => producer.scanToHead(100n), /second public Safe Launch candidate/u);
      assert.equal((await readCurrentPublicLaunchHandoff(directory))?.created.launchId, "7");
      assert.equal(producer.snapshot().cursor, "99");
      assert.equal(producer.snapshot().conflict, true);
      assert.equal(
        (await readdir(join(directory, PUBLIC_LAUNCH_HANDOFF_RECORDS_DIRECTORY))).length,
        2,
      );
      assert.deepEqual(
        await readdir(join(directory, PUBLIC_LAUNCH_HANDOFF_INVALIDATIONS_DIRECTORY)),
        [],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("tombstones a proven reorg, rewinds, and accepts the canonical replacement", async () => {
    const directory = await temporaryDirectory();
    try {
      const oldToken = "0x1111111111111111111111111111111111111111";
      const replacementToken = "0x2222222222222222222222222222222222222222";
      const rpc = new FakePublicRpc();
      rpc.results = [rawCreated({ id: 7n, token: oldToken, block: 100n })];
      const producer = publicProducer({
        requester: rpc,
        directory,
        initialCursor: 99n,
        now: () => "2026-08-20T01:00:00.000Z",
      });
      await producer.scanToHead(100n);
      assert.equal(
        (await readCurrentPublicLaunchHandoff(directory))?.created.blockHash,
        BLOCK_HASH_A,
      );

      rpc.canonicalBlockHashes.set(100n, BLOCK_HASH_B);
      rpc.results = [
        rawCreated({
          id: 8n,
          token: replacementToken,
          block: 100n,
          transactionHash: `0x${"88".repeat(32)}`,
        }),
      ];
      const replacement = await producer.scanToHead(100n);

      assert.equal(replacement.created, 1);
      assert.equal(replacement.fromBlock, 100n);
      assert.equal(producer.snapshot().conflict, false);
      assert.equal(producer.snapshot().cursor, "100");
      const current = await readCurrentPublicLaunchHandoff(directory);
      assert.equal(current?.created.launchId, "8");
      assert.equal(current?.created.tokenAddress, replacementToken);
      assert.equal(current?.created.blockHash, BLOCK_HASH_B);
      assert.equal(
        (await readdir(join(directory, PUBLIC_LAUNCH_HANDOFF_RECORDS_DIRECTORY))).length,
        2,
      );
      const invalidations = await readdir(
        join(directory, PUBLIC_LAUNCH_HANDOFF_INVALIDATIONS_DIRECTORY),
      );
      assert.equal(invalidations.length, 1);
      const tombstone = JSON.parse(
        await readFile(
          join(directory, PUBLIC_LAUNCH_HANDOFF_INVALIDATIONS_DIRECTORY, invalidations[0] ?? ""),
          "utf8",
        ),
      ) as { readonly expectedBlockHash?: string; readonly observedCanonicalBlockHash?: string };
      assert.equal(tombstone.expectedBlockHash, BLOCK_HASH_A);
      assert.equal(tombstone.observedCanonicalBlockHash, BLOCK_HASH_B);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not tombstone or replace current after a transient canonical verification failure", async () => {
    const directory = await temporaryDirectory();
    try {
      const rpc = new FakePublicRpc();
      rpc.results = [rawCreated({ id: 7n, block: 100n })];
      const producer = publicProducer({ requester: rpc, directory, initialCursor: 99n });
      await producer.scanToHead(100n);
      const pointerBefore = await readFile(
        join(directory, PUBLIC_LAUNCH_HANDOFF_CURRENT_FILENAME),
        "utf8",
      );

      rpc.canonicalBlockHashes.set(100n, BLOCK_HASH_B);
      rpc.blockFailuresRemaining = 1;
      rpc.results = [
        rawCreated({
          id: 8n,
          token: "0x2222222222222222222222222222222222222222",
          block: 100n,
        }),
      ];
      await assert.rejects(
        () => producer.scanToHead(100n),
        /canonical block temporarily unavailable/u,
      );

      assert.equal(
        await readFile(join(directory, PUBLIC_LAUNCH_HANDOFF_CURRENT_FILENAME), "utf8"),
        pointerBefore,
      );
      assert.equal((await readCurrentPublicLaunchHandoff(directory))?.created.launchId, "7");
      assert.deepEqual(
        await readdir(join(directory, PUBLIC_LAUNCH_HANDOFF_INVALIDATIONS_DIRECTORY)),
        [],
      );
      assert.equal(producer.snapshot().cursor, "100");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for two public confirmations before publishing a candidate", async () => {
    const directory = await temporaryDirectory();
    try {
      const rpc = new FakePublicRpc();
      rpc.results = [rawCreated({ block: 100n })];
      const producer = new PublicSafeLaunchHandoffProducer({
        requester: rpc,
        directory,
        initialCursor: 99n,
      });
      const early = await producer.scanToHead(101n);
      assert.equal(early.created, 0);
      assert.equal(early.fromBlock, null);
      assert.equal(await readCurrentPublicLaunchHandoff(directory), null);

      const confirmed = await producer.scanToHead(102n);
      assert.equal(confirmed.created, 1);
      assert.equal(confirmed.toBlock, 100n);
      assert.equal((await readCurrentPublicLaunchHandoff(directory))?.created.launchId, "7");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("public launch handoff strict reader", () => {
  it("keeps Control output group-readable under the hardened service umask", async () => {
    const directory = await temporaryDirectory();
    const previousUmask = process.umask(0o077);
    try {
      const rpc = new FakePublicRpc();
      rpc.results = [rawCreated({ id: 7n, block: 100n })];
      await publicProducer({ requester: rpc, directory, initialCursor: 99n }).scanToHead(100n);

      const store = new PublicLaunchHandoffStore(directory);
      const current = await store.readCurrent();
      if (current === null) throw new Error("expected active handoff fixture");
      await store.invalidateCurrentForReorg({
        expected: current,
        observedCanonicalBlockHash: BLOCK_HASH_B,
        rewindToBlock: 99n,
        observedAt: "2026-08-20T02:59:00.000Z",
      });

      const root = await lstat(directory);
      for (const child of [
        directory,
        join(directory, PUBLIC_LAUNCH_HANDOFF_RECORDS_DIRECTORY),
        join(directory, PUBLIC_LAUNCH_HANDOFF_INVALIDATIONS_DIRECTORY),
      ]) {
        const metadata = await lstat(child);
        assert.equal(metadata.mode & 0o7777, 0o2750, child);
        assert.equal(metadata.uid, root.uid, child);
        assert.equal(metadata.gid, root.gid, child);
        assert.equal(metadata.mode & 0o050, 0o050, `${child} must be group-traversable`);
      }

      const pointer = JSON.parse(
        await readFile(join(directory, PUBLIC_LAUNCH_HANDOFF_CURRENT_FILENAME), "utf8"),
      ) as { readonly recordFilename: string; readonly invalidationFilename: string };
      const sharedFiles = [
        join(directory, PUBLIC_LAUNCH_HANDOFF_CURRENT_FILENAME),
        join(directory, PUBLIC_LAUNCH_HANDOFF_CURSOR_FILENAME),
        join(directory, PUBLIC_LAUNCH_HANDOFF_ACTIVE_SIGNAL_FILENAME),
        join(directory, PUBLIC_LAUNCH_HANDOFF_RECORDS_DIRECTORY, pointer.recordFilename),
        join(
          directory,
          PUBLIC_LAUNCH_HANDOFF_INVALIDATIONS_DIRECTORY,
          pointer.invalidationFilename,
        ),
      ];
      for (const file of sharedFiles) {
        const metadata = await lstat(file);
        assert.equal(metadata.mode & 0o777, 0o640, file);
        assert.equal(metadata.uid, root.uid, file);
        assert.equal(metadata.gid, root.gid, file);
        assert.equal(metadata.mode & 0o040, 0o040, `${file} must be group-readable`);
        assert.ok((await readFile(file, "utf8")).length > 0, file);
      }
    } finally {
      process.umask(previousUmask);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when the pre-provisioned handoff root has the wrong mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clockin-public-handoff-loose-"));
    try {
      await chmod(directory, 0o0750);
      await assert.rejects(
        () => new PublicLaunchHandoffStore(directory).initialize(),
        /exact mode 2750/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not issue mkdir or chmod when the exact shared children already exist", async () => {
    const directory = await temporaryDirectory();
    try {
      for (const child of [
        PUBLIC_LAUNCH_HANDOFF_RECORDS_DIRECTORY,
        PUBLIC_LAUNCH_HANDOFF_INVALIDATIONS_DIRECTORY,
      ]) {
        const childPath = join(directory, child);
        await mkdir(childPath, { mode: 0o0750 });
        await chmod(childPath, 0o2750);
      }
      let mutationCalls = 0;
      const rejectMutation = async (): Promise<void> => {
        mutationCalls += 1;
        throw Object.assign(new Error("RestrictSUIDSGID blocked directory mutation"), {
          code: "EPERM",
        });
      };
      const store = new PublicLaunchHandoffStore(directory, {
        create: rejectMutation,
        setMode: rejectMutation,
      });

      await store.initialize();
      assert.equal(mutationCalls, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("re-signals an existing immutable handoff for reboot-safe PathChanged activation", async () => {
    const directory = await temporaryDirectory();
    try {
      const initialRpc = new FakePublicRpc();
      initialRpc.results = [rawCreated()];
      const producer = publicProducer({
        requester: initialRpc,
        directory,
        initialCursor: 99n,
        now: () => "2026-08-20T03:00:00.000Z",
      });
      await producer.scanToHead(100n);
      const currentBefore = await readFile(join(directory, "current.json"), "utf8");
      const signalBefore = await readFile(
        join(directory, PUBLIC_LAUNCH_HANDOFF_ACTIVE_SIGNAL_FILENAME),
        "utf8",
      );
      const restartedRpc = new FakePublicRpc();
      const restarted = publicProducer({
        requester: restartedRpc,
        directory,
        initialCursor: 99n,
        now: () => "2026-08-20T03:01:00.000Z",
      });
      assert.equal(await restarted.signalExistingCurrent(), true);
      const currentAfter = await readFile(join(directory, "current.json"), "utf8");
      const signalAfter = await readFile(
        join(directory, PUBLIC_LAUNCH_HANDOFF_ACTIVE_SIGNAL_FILENAME),
        "utf8",
      );
      assert.equal(currentAfter, currentBefore);
      assert.notEqual(signalAfter, signalBefore);
      assert.equal((await readCurrentPublicLaunchHandoff(directory))?.created.launchId, "7");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not emit a boot activation signal for a handoff that is no longer canonical", async () => {
    const directory = await temporaryDirectory();
    try {
      const initialRpc = new FakePublicRpc();
      initialRpc.results = [rawCreated({ block: 100n })];
      await publicProducer({
        requester: initialRpc,
        directory,
        initialCursor: 99n,
        now: () => "2026-08-20T03:10:00.000Z",
      }).scanToHead(100n);
      const signalPath = join(directory, PUBLIC_LAUNCH_HANDOFF_ACTIVE_SIGNAL_FILENAME);
      const signalBefore = await readFile(signalPath, "utf8");

      const restartedRpc = new FakePublicRpc();
      restartedRpc.canonicalBlockHashes.set(100n, BLOCK_HASH_B);
      const restarted = publicProducer({
        requester: restartedRpc,
        directory,
        initialCursor: 99n,
        now: () => "2026-08-20T03:11:00.000Z",
      });
      assert.equal(await restarted.signalExistingCurrent(), false);
      assert.equal(await readFile(signalPath, "utf8"), signalBefore);
      assert.equal(await readCurrentPublicLaunchHandoff(directory), null);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("signals only active records across valid, reorg tombstone, and replacement states", async () => {
    const directory = await temporaryDirectory();
    try {
      const rpc = new FakePublicRpc();
      rpc.results = [rawCreated({ id: 7n, block: 100n })];
      const first = publicProducer({
        requester: rpc,
        directory,
        initialCursor: 99n,
        now: () => "2026-08-20T04:00:00.000Z",
      });
      await first.scanToHead(100n);
      const signalPath = join(directory, PUBLIC_LAUNCH_HANDOFF_ACTIVE_SIGNAL_FILENAME);
      const firstSignal = await readFile(signalPath, "utf8");
      const current = await readCurrentPublicLaunchHandoff(directory);
      if (current === null) throw new Error("expected active handoff fixture");

      await new PublicLaunchHandoffStore(directory).invalidateCurrentForReorg({
        expected: current,
        observedCanonicalBlockHash: BLOCK_HASH_B,
        rewindToBlock: 99n,
        observedAt: "2026-08-20T04:01:00.000Z",
      });
      assert.equal(await readFile(signalPath, "utf8"), firstSignal);
      assert.equal(await readCurrentPublicLaunchHandoff(directory), null);

      rpc.canonicalBlockHashes.set(100n, BLOCK_HASH_B);
      rpc.results = [
        rawCreated({
          id: 8n,
          token: "0x2222222222222222222222222222222222222222",
          block: 100n,
          transactionHash: `0x${"88".repeat(32)}`,
        }),
      ];
      const replacement = publicProducer({
        requester: rpc,
        directory,
        initialCursor: 99n,
        now: () => "2026-08-20T04:02:00.000Z",
      });
      await replacement.scanToHead(100n);
      const replacementSignal = await readFile(signalPath, "utf8");
      assert.notEqual(replacementSignal, firstSignal);
      assert.match(replacementSignal, /ACTIVE_PUBLIC_LAUNCH_HANDOFF_SIGNAL/u);
      assert.equal((await readCurrentPublicLaunchHandoff(directory))?.created.launchId, "8");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("re-signals a same-id public Armed event so a timed-out executor can restart", async () => {
    const directory = await temporaryDirectory();
    try {
      const rpc = new FakePublicRpc();
      rpc.results = [rawCreated({ id: 7n, block: 100n })];
      let now = "2026-08-20T05:00:00.000Z";
      const producer = publicProducer({
        requester: rpc,
        directory,
        initialCursor: 99n,
        now: () => now,
      });
      await producer.scanToHead(100n);
      const signalPath = join(directory, PUBLIC_LAUNCH_HANDOFF_ACTIVE_SIGNAL_FILENAME);
      const before = await readFile(signalPath, "utf8");

      now = "2026-08-20T05:16:00.000Z";
      rpc.results = [rawArmed({ id: 7n, block: 101n })];
      const result = await producer.scanToHead(101n);
      assert.equal(result.armedSignals, 1);
      assert.notEqual(await readFile(signalPath, "utf8"), before);
      const armedFilter = rpc.calls
        .filter((call) => call.method === "eth_getLogs")
        .map((call) => call.params[0] as { readonly topics?: readonly unknown[] })
        .find((filter) => filter.topics?.[0] === STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC);
      assert.deepEqual(armedFilter?.topics, [
        STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
        toBeHex(7n, 32),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a loose current pointer mode and a symlink pointer", async () => {
    const directory = await temporaryDirectory();
    try {
      const rpc = new FakePublicRpc();
      rpc.results = [rawCreated()];
      await publicProducer({
        requester: rpc,
        directory,
        initialCursor: 99n,
      }).scanToHead(100n);
      const current = join(directory, PUBLIC_LAUNCH_HANDOFF_CURRENT_FILENAME);
      await chmod(current, 0o666);
      await assert.rejects(() => readCurrentPublicLaunchHandoff(directory), /mode 0640/u);

      await rm(current);
      const target = join(directory, "unsafe-current.json");
      await writeFile(target, "{}\n", { mode: 0o640 });
      await symlink(target, current);
      await assert.rejects(() => readCurrentPublicLaunchHandoff(directory), /non-symlink/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a record whose compiled-profile binding was changed", async () => {
    const directory = await temporaryDirectory();
    try {
      const rpc = new FakePublicRpc();
      rpc.results = [rawCreated()];
      await publicProducer({
        requester: rpc,
        directory,
        initialCursor: 99n,
      }).scanToHead(100n);
      const pointer = JSON.parse(
        await readFile(join(directory, PUBLIC_LAUNCH_HANDOFF_CURRENT_FILENAME), "utf8"),
      ) as { readonly recordFilename: string };
      const recordPath = join(
        directory,
        PUBLIC_LAUNCH_HANDOFF_RECORDS_DIRECTORY,
        pointer.recordFilename,
      );
      const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
      await writeFile(
        recordPath,
        `${JSON.stringify({ ...record, profileHash: "sha256:changed" }, null, 2)}\n`,
      );
      await chmod(recordPath, 0o640);
      await assert.rejects(
        () => readCurrentPublicLaunchHandoff(directory),
        /compiled Safe Launch constants/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps credentials and paid RPC endpoint inputs out of the producer source", async () => {
    const sources = await Promise.all([
      readFile(new URL("../src/runtime/public-launch-handoff.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/control/public-safe-launch-handoff.ts", import.meta.url), "utf8"),
    ]);
    for (const source of sources) {
      for (const forbidden of [
        "readSystemdCredential",
        "rpc_http",
        "rpc_wss",
        "privateKey",
        "loadProductionWalletSigners",
      ]) {
        assert.doesNotMatch(source, new RegExp(forbidden, "u"), forbidden);
      }
    }
  });
});
