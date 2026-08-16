import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { PreparedTrancheMetadata } from "./live-transaction-source.js";
import { assertAddress, assertHex } from "./rpc/hex.js";
import type { Hex } from "./rpc/types.js";

export interface LiveLedgerEvent {
  readonly event: string;
  readonly [key: string]: unknown;
}

export interface LiveLedger {
  append(event: LiveLedgerEvent): Promise<void>;
}

export interface LiveRecoverySnapshot {
  readonly launchId: string;
  readonly walletAddress: Hex;
  readonly beneficiaryAddress: Hex;
  readonly tokenAddress: Hex;
  readonly tokenBalanceBefore: bigint;
  readonly attemptedTransactions: readonly PreparedTrancheMetadata[];
}

type LedgerRecord = Readonly<Record<string, unknown>>;

async function readLedgerRecords(path: string): Promise<readonly LedgerRecord[]> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const records: LedgerRecord[] = [];
  for (const [index, line] of contents.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`live ledger contains invalid JSON at line ${index + 1}`);
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new Error(`live ledger contains a non-object record at line ${index + 1}`);
    }
    records.push(record as LedgerRecord);
  }
  return records;
}

function requiredString(record: LedgerRecord, name: string): string {
  const value = record[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`live ledger record is missing ${name}`);
  }
  return value;
}

function requiredSafeInteger(record: LedgerRecord, name: string): number {
  const value = record[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`live ledger record has invalid ${name}`);
  }
  return value;
}

function requiredBigInt(record: LedgerRecord, name: string): bigint {
  try {
    const value = BigInt(requiredString(record, name));
    if (value < 0n) throw new Error();
    return value;
  } catch {
    throw new Error(`live ledger record has invalid ${name}`);
  }
}

export async function loadLiveRecoverySnapshot(
  path: string,
  launchId: string,
): Promise<LiveRecoverySnapshot> {
  const records = await readLedgerRecords(path);
  const sessions = records.filter(
    (record) => record.event === "live_session_started" && record.launchId === launchId,
  );
  if (sessions.length !== 1) {
    throw new Error(`expected exactly one live session for launch ${launchId}`);
  }
  const session = sessions[0];
  if (session === undefined) throw new Error("live session disappeared during recovery");

  const walletAddress = requiredString(session, "walletAddress");
  const beneficiaryAddress = requiredString(session, "beneficiaryAddress");
  const tokenAddress = requiredString(session, "tokenAddress");
  assertAddress("ledger walletAddress", walletAddress);
  assertAddress("ledger beneficiaryAddress", beneficiaryAddress);
  assertAddress("ledger tokenAddress", tokenAddress);

  const plans = new Map<string, PreparedTrancheMetadata>();
  for (const record of records) {
    if (record.event !== "plan_frozen" || record.launchId !== launchId) continue;
    const intentId = requiredString(record, "intentId");
    const txHash = requiredString(record, "txHash");
    assertHex("ledger txHash", txHash);
    if (txHash.length !== 66) throw new Error("live ledger txHash is not 32 bytes");
    plans.set(
      txHash.toLowerCase(),
      Object.freeze({
        intentId,
        trancheNumber: requiredSafeInteger(record, "tranche"),
        nonce: requiredSafeInteger(record, "nonce"),
        txHash: txHash as Hex,
        valueWei: requiredBigInt(record, "valueWei"),
        gasLimit: requiredBigInt(record, "gasLimit"),
        maxFeePerGasWei: requiredBigInt(record, "maxFeePerGasWei"),
        maxPriorityFeePerGasWei: requiredBigInt(record, "maxPriorityFeePerGasWei"),
      }),
    );
  }

  const attemptedHashes = new Set<string>();
  for (const record of records) {
    if (record.event !== "broadcast_attempted" || record.launchId !== launchId) continue;
    attemptedHashes.add(requiredString(record, "txHash").toLowerCase());
  }
  const attemptedTransactions = [...attemptedHashes].map((txHash) => {
    const metadata = plans.get(txHash);
    if (metadata === undefined) {
      throw new Error(`broadcast attempt ${txHash} has no frozen plan`);
    }
    return metadata;
  });
  attemptedTransactions.sort((left, right) => left.trancheNumber - right.trancheNumber);

  return Object.freeze({
    launchId,
    walletAddress: walletAddress as Hex,
    beneficiaryAddress: beneficiaryAddress as Hex,
    tokenAddress: tokenAddress as Hex,
    tokenBalanceBefore: requiredBigInt(session, "tokenBalanceBefore"),
    attemptedTransactions: Object.freeze(attemptedTransactions),
  });
}

/** Prevents a restart from silently spending another 10 batches for one launch. */
export async function assertLiveLaunchUnused(path: string, launchId: string): Promise<void> {
  const records = await readLedgerRecords(path);
  for (const record of records) {
    if (
      "event" in record &&
      record.event === "live_session_started" &&
      "launchId" in record &&
      record.launchId === launchId
    ) {
      throw new Error(`launch ${launchId} already exists in the live ledger`);
    }
  }
}

export class FileLiveLedger implements LiveLedger {
  readonly #path: string;
  readonly #now: () => Date;
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string, now: () => Date = () => new Date()) {
    if (path.trim().length === 0) throw new RangeError("ledger path must not be empty");
    this.#path = path;
    this.#now = now;
  }

  append(event: LiveLedgerEvent): Promise<void> {
    return this.appendMany([event]);
  }

  /** Persists related hot-path records with one append and one permission check. */
  appendMany(events: readonly LiveLedgerEvent[]): Promise<void> {
    if (events.length === 0) return this.#tail;
    const records = events
      .map((event) =>
        JSON.stringify({
          ...event,
          sequenceTime: this.#now().toISOString(),
        }),
      )
      .join("\n");
    this.#tail = this.#tail.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      await appendFile(this.#path, `${records}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(this.#path, 0o600);
    });
    return this.#tail;
  }
}

export class InMemoryLiveLedger implements LiveLedger {
  readonly events: LiveLedgerEvent[] = [];

  async append(event: LiveLedgerEvent): Promise<void> {
    this.events.push(Object.freeze({ ...event }));
  }

  async appendMany(events: readonly LiveLedgerEvent[]): Promise<void> {
    for (const event of events) await this.append(event);
  }
}
