import type { Stats } from "node:fs";
import { chmod, link, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { getAddress } from "ethers";

import {
  CLOCKIN_APPROVED_LAUNCH_CREATOR,
  ROBINHOOD_WETH_ADDRESS,
  ROBINHOOD_WETH_RUNTIME_CODE_HASH,
  STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
  STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
  STONK_SAFE_LAUNCH_WETH_FACTORY_RUNTIME_CODE_HASH,
  type StonkSafeLaunchQuotedCreated,
} from "../adapters/stonk-safe-launch-quoted.js";
import { stableHash } from "../core/canonical.js";

export const PUBLIC_LAUNCH_HANDOFF_FORMAT_VERSION = 1 as const;
export const PUBLIC_LAUNCH_HANDOFF_DEFAULT_DIRECTORY = "/var/lib/clockin-handoff/outbox";
export const PUBLIC_LAUNCH_HANDOFF_CURRENT_FILENAME = "current.json";
export const PUBLIC_LAUNCH_HANDOFF_CURSOR_FILENAME = "cursor.json";
export const PUBLIC_LAUNCH_HANDOFF_ACTIVE_SIGNAL_FILENAME = "active.signal";
export const PUBLIC_LAUNCH_HANDOFF_RECORDS_DIRECTORY = "records";
export const PUBLIC_LAUNCH_HANDOFF_INVALIDATIONS_DIRECTORY = "invalidations";

const PUBLIC_LAUNCH_HANDOFF_DIRECTORY_MODE = 0o2750;
const PUBLIC_LAUNCH_HANDOFF_PARENT_MODE = 0o0750;

export const PUBLIC_LAUNCH_HANDOFF_PROFILE_CONSTANTS = Object.freeze({
  chainId: 4_663,
  factoryAddress: STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
  factoryRuntimeCodeHash: STONK_SAFE_LAUNCH_WETH_FACTORY_RUNTIME_CODE_HASH,
  createdTopic0: STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
  approvedCreator: CLOCKIN_APPROVED_LAUNCH_CREATOR,
  quoteAsset: ROBINHOOD_WETH_ADDRESS,
  quoteAssetRuntimeCodeHash: ROBINHOOD_WETH_RUNTIME_CODE_HASH,
  externalToken: false,
});

export const PUBLIC_LAUNCH_HANDOFF_PROFILE_HASH = stableHash(
  PUBLIC_LAUNCH_HANDOFF_PROFILE_CONSTANTS,
);

export interface PublicLaunchHandoffCreated {
  readonly factoryAddress: string;
  readonly launchId: string;
  readonly tokenAddress: string;
  readonly creatorAddress: string;
  readonly externalToken: false;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logIndex: string;
}

export interface PublicLaunchHandoffRecord {
  readonly formatVersion: 1;
  readonly kind: "CLOCKIN_SAFE_LAUNCH_CREATED";
  readonly profileHash: string;
  readonly handoffId: string;
  readonly chainId: 4_663;
  readonly source: "OFFICIAL_PUBLIC_HTTP_EXACT_LOG";
  readonly observedAt: string;
  readonly created: PublicLaunchHandoffCreated;
}

interface PublicLaunchHandoffPointer {
  readonly formatVersion: 1;
  readonly kind: "CURRENT_PUBLIC_LAUNCH_HANDOFF";
  readonly profileHash: string;
  readonly handoffId: string;
  readonly recordFilename: string;
  readonly recordHash: string;
  readonly updatedAt: string;
}

interface PublicLaunchHandoffActiveSignal {
  readonly formatVersion: 1;
  readonly kind: "ACTIVE_PUBLIC_LAUNCH_HANDOFF_SIGNAL";
  readonly profileHash: string;
  readonly handoffId: string;
  readonly recordHash: string;
  readonly updatedAt: string;
}

export interface PublicLaunchHandoffInvalidation {
  readonly formatVersion: 1;
  readonly kind: "PUBLIC_LAUNCH_HANDOFF_REORG_INVALIDATION";
  readonly profileHash: string;
  readonly invalidationId: string;
  readonly handoffId: string;
  readonly recordFilename: string;
  readonly recordHash: string;
  readonly blockNumber: string;
  readonly expectedBlockHash: string;
  readonly observedCanonicalBlockHash: string;
  readonly rewindToBlock: string;
  readonly observedAt: string;
}

interface PublicLaunchHandoffInvalidatedPointer {
  readonly formatVersion: 1;
  readonly kind: "INVALIDATED_PUBLIC_LAUNCH_HANDOFF";
  readonly profileHash: string;
  readonly handoffId: string;
  readonly recordFilename: string;
  readonly recordHash: string;
  readonly invalidationId: string;
  readonly invalidationFilename: string;
  readonly invalidationHash: string;
  readonly updatedAt: string;
}

type PublicLaunchHandoffPointerState =
  | Readonly<{ state: "EMPTY" }>
  | Readonly<{ state: "ACTIVE"; pointer: PublicLaunchHandoffPointer }>
  | Readonly<{
      state: "INVALIDATED";
      pointer: PublicLaunchHandoffInvalidatedPointer;
      invalidation: PublicLaunchHandoffInvalidation;
    }>;

export interface PublicLaunchHandoffCursor {
  readonly formatVersion: 1;
  readonly kind: "PUBLIC_SAFE_LAUNCH_CURSOR";
  readonly profileHash: string;
  readonly lastCompletedBlock: string;
  readonly updatedAt: string;
}

export type PublicLaunchHandoffPublishResult =
  | Readonly<{ state: "CREATED" | "DUPLICATE"; record: PublicLaunchHandoffRecord }>
  | Readonly<{
      state: "CONFLICT";
      record: PublicLaunchHandoffRecord;
      current: PublicLaunchHandoffRecord;
    }>;

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an invalid schema`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function decimal(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(parsed)) throw new Error(`${label} is not canonical decimal`);
  return parsed;
}

function address(value: unknown, label: string): string {
  const parsed = string(value, label);
  try {
    return getAddress(parsed);
  } catch (error) {
    throw new Error(`${label} is not an address`, { cause: error });
  }
}

function hex32(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!/^0x[0-9a-fA-F]{64}$/u.test(parsed)) throw new Error(`${label} is not bytes32`);
  return parsed;
}

function iso(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!Number.isFinite(Date.parse(parsed)) || new Date(parsed).toISOString() !== parsed) {
    throw new Error(`${label} is not a canonical ISO timestamp`);
  }
  return parsed;
}

function profileHash(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (parsed !== PUBLIC_LAUNCH_HANDOFF_PROFILE_HASH) {
    throw new Error(`${label} is not bound to the compiled Safe Launch constants`);
  }
  return parsed;
}

function handoffIdentity(created: PublicLaunchHandoffCreated): string {
  return `safe-launch-${stableHash({
    profileHash: PUBLIC_LAUNCH_HANDOFF_PROFILE_HASH,
    launchId: created.launchId,
    tokenAddress: created.tokenAddress.toLowerCase(),
    blockNumber: created.blockNumber,
    transactionHash: created.transactionHash.toLowerCase(),
    blockHash: created.blockHash.toLowerCase(),
    logIndex: created.logIndex,
  }).slice("sha256:".length)}`;
}

function recordFilename(record: PublicLaunchHandoffRecord): string {
  return `${record.handoffId}.json`;
}

export function parsePublicLaunchHandoffRecord(value: unknown): PublicLaunchHandoffRecord {
  const raw = object(value, "public launch handoff");
  exactKeys(
    raw,
    [
      "formatVersion",
      "kind",
      "profileHash",
      "handoffId",
      "chainId",
      "source",
      "observedAt",
      "created",
    ],
    "public launch handoff",
  );
  if (raw.formatVersion !== PUBLIC_LAUNCH_HANDOFF_FORMAT_VERSION) {
    throw new Error("public launch handoff formatVersion is invalid");
  }
  if (raw.kind !== "CLOCKIN_SAFE_LAUNCH_CREATED") {
    throw new Error("public launch handoff kind is invalid");
  }
  if (raw.chainId !== PUBLIC_LAUNCH_HANDOFF_PROFILE_CONSTANTS.chainId) {
    throw new Error("public launch handoff chainId is invalid");
  }
  if (raw.source !== "OFFICIAL_PUBLIC_HTTP_EXACT_LOG") {
    throw new Error("public launch handoff source is invalid");
  }
  const createdRaw = object(raw.created, "public launch handoff created");
  exactKeys(
    createdRaw,
    [
      "factoryAddress",
      "launchId",
      "tokenAddress",
      "creatorAddress",
      "externalToken",
      "blockNumber",
      "blockHash",
      "transactionHash",
      "logIndex",
    ],
    "public launch handoff created",
  );
  const created: PublicLaunchHandoffCreated = Object.freeze({
    factoryAddress: address(createdRaw.factoryAddress, "created.factoryAddress"),
    launchId: decimal(createdRaw.launchId, "created.launchId"),
    tokenAddress: address(createdRaw.tokenAddress, "created.tokenAddress"),
    creatorAddress: address(createdRaw.creatorAddress, "created.creatorAddress"),
    externalToken:
      createdRaw.externalToken === false
        ? false
        : (() => {
            throw new Error("created.externalToken must be false");
          })(),
    blockNumber: decimal(createdRaw.blockNumber, "created.blockNumber"),
    blockHash: hex32(createdRaw.blockHash, "created.blockHash"),
    transactionHash: hex32(createdRaw.transactionHash, "created.transactionHash"),
    logIndex: decimal(createdRaw.logIndex, "created.logIndex"),
  });
  if (
    created.factoryAddress.toLowerCase() !==
    PUBLIC_LAUNCH_HANDOFF_PROFILE_CONSTANTS.factoryAddress.toLowerCase()
  ) {
    throw new Error("public launch handoff factory is not the compiled WETH pad");
  }
  if (
    created.creatorAddress.toLowerCase() !==
    PUBLIC_LAUNCH_HANDOFF_PROFILE_CONSTANTS.approvedCreator.toLowerCase()
  ) {
    throw new Error("public launch handoff creator is not approved");
  }
  if (BigInt(created.launchId) <= 0n) throw new Error("created.launchId must be positive");
  const handoffId = string(raw.handoffId, "public launch handoff handoffId");
  if (handoffId !== handoffIdentity(created)) {
    throw new Error("public launch handoff identity hash is invalid");
  }
  return Object.freeze({
    formatVersion: PUBLIC_LAUNCH_HANDOFF_FORMAT_VERSION,
    kind: "CLOCKIN_SAFE_LAUNCH_CREATED",
    profileHash: profileHash(raw.profileHash, "public launch handoff profileHash"),
    handoffId,
    chainId: 4_663,
    source: "OFFICIAL_PUBLIC_HTTP_EXACT_LOG",
    observedAt: iso(raw.observedAt, "public launch handoff observedAt"),
    created,
  });
}

function parsePointer(value: unknown): PublicLaunchHandoffPointer {
  const raw = object(value, "public launch handoff pointer");
  exactKeys(
    raw,
    [
      "formatVersion",
      "kind",
      "profileHash",
      "handoffId",
      "recordFilename",
      "recordHash",
      "updatedAt",
    ],
    "public launch handoff pointer",
  );
  if (raw.formatVersion !== 1 || raw.kind !== "CURRENT_PUBLIC_LAUNCH_HANDOFF") {
    throw new Error("public launch handoff pointer header is invalid");
  }
  const handoffId = string(raw.handoffId, "public launch handoff pointer handoffId");
  const filename = string(raw.recordFilename, "public launch handoff pointer recordFilename");
  if (!/^safe-launch-[0-9a-f]{64}\.json$/u.test(filename) || filename !== `${handoffId}.json`) {
    throw new Error("public launch handoff pointer recordFilename is invalid");
  }
  const recordHash = string(raw.recordHash, "public launch handoff pointer recordHash");
  if (!/^sha256:[0-9a-f]{64}$/u.test(recordHash)) {
    throw new Error("public launch handoff pointer recordHash is invalid");
  }
  return Object.freeze({
    formatVersion: 1,
    kind: "CURRENT_PUBLIC_LAUNCH_HANDOFF",
    profileHash: profileHash(raw.profileHash, "public launch handoff pointer profileHash"),
    handoffId,
    recordFilename: filename,
    recordHash,
    updatedAt: iso(raw.updatedAt, "public launch handoff pointer updatedAt"),
  });
}

function parseInvalidatedPointer(value: unknown): PublicLaunchHandoffInvalidatedPointer {
  const raw = object(value, "public launch handoff invalidated pointer");
  exactKeys(
    raw,
    [
      "formatVersion",
      "kind",
      "profileHash",
      "handoffId",
      "recordFilename",
      "recordHash",
      "invalidationId",
      "invalidationFilename",
      "invalidationHash",
      "updatedAt",
    ],
    "public launch handoff invalidated pointer",
  );
  if (raw.formatVersion !== 1 || raw.kind !== "INVALIDATED_PUBLIC_LAUNCH_HANDOFF") {
    throw new Error("public launch handoff invalidated pointer header is invalid");
  }
  const handoffId = string(raw.handoffId, "invalidated pointer handoffId");
  const record = string(raw.recordFilename, "invalidated pointer recordFilename");
  if (!/^safe-launch-[0-9a-f]{64}\.json$/u.test(record) || record !== `${handoffId}.json`) {
    throw new Error("public launch handoff invalidated pointer recordFilename is invalid");
  }
  const recordHash = string(raw.recordHash, "invalidated pointer recordHash");
  if (!/^sha256:[0-9a-f]{64}$/u.test(recordHash)) {
    throw new Error("public launch handoff invalidated pointer recordHash is invalid");
  }
  const invalidationId = string(raw.invalidationId, "invalidated pointer invalidationId");
  if (!/^reorg-[0-9a-f]{64}$/u.test(invalidationId)) {
    throw new Error("public launch handoff invalidated pointer invalidationId is invalid");
  }
  const invalidationFilename = string(
    raw.invalidationFilename,
    "invalidated pointer invalidationFilename",
  );
  if (invalidationFilename !== `${invalidationId}.json`) {
    throw new Error("public launch handoff invalidated pointer filename is invalid");
  }
  const invalidationHash = string(raw.invalidationHash, "invalidated pointer invalidationHash");
  if (!/^sha256:[0-9a-f]{64}$/u.test(invalidationHash)) {
    throw new Error("public launch handoff invalidated pointer invalidationHash is invalid");
  }
  return Object.freeze({
    formatVersion: 1,
    kind: "INVALIDATED_PUBLIC_LAUNCH_HANDOFF",
    profileHash: profileHash(raw.profileHash, "invalidated pointer profileHash"),
    handoffId,
    recordFilename: record,
    recordHash,
    invalidationId,
    invalidationFilename,
    invalidationHash,
    updatedAt: iso(raw.updatedAt, "invalidated pointer updatedAt"),
  });
}

function parseInvalidation(value: unknown): PublicLaunchHandoffInvalidation {
  const raw = object(value, "public launch handoff invalidation");
  exactKeys(
    raw,
    [
      "formatVersion",
      "kind",
      "profileHash",
      "invalidationId",
      "handoffId",
      "recordFilename",
      "recordHash",
      "blockNumber",
      "expectedBlockHash",
      "observedCanonicalBlockHash",
      "rewindToBlock",
      "observedAt",
    ],
    "public launch handoff invalidation",
  );
  if (raw.formatVersion !== 1 || raw.kind !== "PUBLIC_LAUNCH_HANDOFF_REORG_INVALIDATION") {
    throw new Error("public launch handoff invalidation header is invalid");
  }
  const handoffId = string(raw.handoffId, "invalidation handoffId");
  const filename = string(raw.recordFilename, "invalidation recordFilename");
  if (!/^safe-launch-[0-9a-f]{64}\.json$/u.test(filename) || filename !== `${handoffId}.json`) {
    throw new Error("public launch handoff invalidation recordFilename is invalid");
  }
  const recordHash = string(raw.recordHash, "invalidation recordHash");
  if (!/^sha256:[0-9a-f]{64}$/u.test(recordHash)) {
    throw new Error("public launch handoff invalidation recordHash is invalid");
  }
  const blockNumber = decimal(raw.blockNumber, "invalidation blockNumber");
  const expectedBlockHash = hex32(raw.expectedBlockHash, "invalidation expectedBlockHash");
  const observedCanonicalBlockHash = hex32(
    raw.observedCanonicalBlockHash,
    "invalidation observedCanonicalBlockHash",
  );
  if (observedCanonicalBlockHash.toLowerCase() === expectedBlockHash.toLowerCase()) {
    throw new Error("public launch handoff invalidation does not prove a reorg");
  }
  const rewindToBlock = decimal(raw.rewindToBlock, "invalidation rewindToBlock");
  if (BigInt(rewindToBlock) >= BigInt(blockNumber)) {
    throw new Error("public launch handoff invalidation cursor was not rewound");
  }
  const observedAt = iso(raw.observedAt, "invalidation observedAt");
  const invalidationId = string(raw.invalidationId, "invalidation invalidationId");
  const identity = `reorg-${stableHash({
    profileHash: PUBLIC_LAUNCH_HANDOFF_PROFILE_HASH,
    handoffId,
    recordHash,
    blockNumber,
    expectedBlockHash: expectedBlockHash.toLowerCase(),
    observedCanonicalBlockHash: observedCanonicalBlockHash.toLowerCase(),
    rewindToBlock,
  }).slice("sha256:".length)}`;
  if (invalidationId !== identity) {
    throw new Error("public launch handoff invalidation identity hash is invalid");
  }
  return Object.freeze({
    formatVersion: 1,
    kind: "PUBLIC_LAUNCH_HANDOFF_REORG_INVALIDATION",
    profileHash: profileHash(raw.profileHash, "invalidation profileHash"),
    invalidationId,
    handoffId,
    recordFilename: filename,
    recordHash,
    blockNumber,
    expectedBlockHash,
    observedCanonicalBlockHash,
    rewindToBlock,
    observedAt,
  });
}

function parseCursor(value: unknown): PublicLaunchHandoffCursor {
  const raw = object(value, "public launch handoff cursor");
  exactKeys(
    raw,
    ["formatVersion", "kind", "profileHash", "lastCompletedBlock", "updatedAt"],
    "public launch handoff cursor",
  );
  if (raw.formatVersion !== 1 || raw.kind !== "PUBLIC_SAFE_LAUNCH_CURSOR") {
    throw new Error("public launch handoff cursor header is invalid");
  }
  return Object.freeze({
    formatVersion: 1,
    kind: "PUBLIC_SAFE_LAUNCH_CURSOR",
    profileHash: profileHash(raw.profileHash, "public launch handoff cursor profileHash"),
    lastCompletedBlock: decimal(raw.lastCompletedBlock, "cursor.lastCompletedBlock"),
    updatedAt: iso(raw.updatedAt, "cursor.updatedAt"),
  });
}

export function resolvePublicLaunchHandoffDirectory(
  directory = PUBLIC_LAUNCH_HANDOFF_DEFAULT_DIRECTORY,
): string {
  if (!isAbsolute(directory)) throw new Error("public launch handoff directory must be absolute");
  return resolve(directory);
}

async function readStrictFile(path: string, label: string): Promise<unknown | null> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if ((metadata.mode & 0o777) !== 0o640) throw new Error(`${label} must have mode 0640`);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

type DirectoryMetadata = Stats;

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("public launch handoff requires a POSIX uid");
  return uid;
}

function currentGroups(): readonly number[] {
  const groups = process.getgroups?.();
  if (groups === undefined) throw new Error("public launch handoff requires POSIX groups");
  return groups;
}

function assertSharedDirectory(
  metadata: DirectoryMetadata,
  path: string,
  label: string,
  expected?: Readonly<{ uid: number; gid: number }>,
): void {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  if ((metadata.mode & 0o7777) !== PUBLIC_LAUNCH_HANDOFF_DIRECTORY_MODE) {
    throw new Error(`${label} must have exact mode 2750`);
  }
  if (expected !== undefined && (metadata.uid !== expected.uid || metadata.gid !== expected.gid)) {
    throw new Error(`${label} owner/group does not match the public handoff root`);
  }
  const uid = currentUid();
  if (metadata.uid !== uid && !currentGroups().includes(metadata.gid)) {
    throw new Error(`${path} is not readable through its owner or shared group`);
  }
}

async function inspectDirectory(
  path: string,
  label: string,
  expected?: Readonly<{ uid: number; gid: number }>,
): Promise<DirectoryMetadata | null> {
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  assertSharedDirectory(metadata, path, label, expected);
  return metadata;
}

async function inspectHandoffRoot(path: string, label: string): Promise<DirectoryMetadata | null> {
  const root = await inspectDirectory(path, label);
  if (root === null || path !== resolve(PUBLIC_LAUNCH_HANDOFF_DEFAULT_DIRECTORY)) return root;

  const parentPath = resolve(path, "..");
  const parent = await lstat(parentPath);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error("public launch handoff parent must be a non-symlink directory");
  }
  if ((parent.mode & 0o7777) !== PUBLIC_LAUNCH_HANDOFF_PARENT_MODE) {
    throw new Error("public launch handoff parent must have exact mode 0750");
  }
  if (parent.uid !== 0 || parent.gid !== root.gid) {
    throw new Error("public launch handoff root group does not match its root-owned parent");
  }
  if (!currentGroups().includes(root.gid)) {
    throw new Error("public launch handoff shared group is not assigned to this service");
  }
  return root;
}

async function createSharedChildDirectory(
  path: string,
  label: string,
  root: Readonly<{ uid: number; gid: number }>,
): Promise<void> {
  let created = false;
  try {
    await mkdir(path, { recursive: false, mode: PUBLIC_LAUNCH_HANDOFF_DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // UMask=0077 deliberately removes the group bits requested by mkdir. Only a
  // directory created by this process is normalized; an existing production
  // directory must already match tmpfiles exactly and is never silently repaired.
  if (created) await chmod(path, PUBLIC_LAUNCH_HANDOFF_DIRECTORY_MODE);
  const metadata = await inspectDirectory(path, label, root);
  if (metadata === null) throw new Error(`${label} was not created`);
  if (metadata.uid !== currentUid()) {
    throw new Error(`${label} is not owned by the Control service uid`);
  }
}

async function atomicReplace(path: string, value: unknown): Promise<void> {
  const temporary = join(resolve(path, ".."), `.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o640,
    flag: "wx",
  });
  try {
    await chmod(temporary, 0o640);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function createPublicLaunchHandoffRecord(
  created: StonkSafeLaunchQuotedCreated,
  canonicalBlockHash: string,
  observedAt = new Date().toISOString(),
): PublicLaunchHandoffRecord {
  const createdRecord: PublicLaunchHandoffCreated = Object.freeze({
    factoryAddress: getAddress(created.factoryAddress),
    launchId: created.id.toString(),
    tokenAddress: getAddress(created.tokenAddress),
    creatorAddress: getAddress(created.creatorAddress),
    externalToken: false,
    blockNumber: created.blockNumber.toString(),
    blockHash: hex32(canonicalBlockHash, "created canonical blockHash"),
    transactionHash: created.transactionHash,
    logIndex: created.logIndex.toString(),
  });
  if (created.externalToken) throw new Error("CLOCKIN public handoff rejects external launches");
  return parsePublicLaunchHandoffRecord({
    formatVersion: 1,
    kind: "CLOCKIN_SAFE_LAUNCH_CREATED",
    profileHash: PUBLIC_LAUNCH_HANDOFF_PROFILE_HASH,
    handoffId: handoffIdentity(createdRecord),
    chainId: 4_663,
    source: "OFFICIAL_PUBLIC_HTTP_EXACT_LOG",
    observedAt,
    created: createdRecord,
  });
}

export class PublicLaunchHandoffStore {
  readonly directory: string;
  readonly recordsDirectory: string;
  readonly invalidationsDirectory: string;

  constructor(directory = PUBLIC_LAUNCH_HANDOFF_DEFAULT_DIRECTORY) {
    this.directory = resolvePublicLaunchHandoffDirectory(directory);
    this.recordsDirectory = join(this.directory, PUBLIC_LAUNCH_HANDOFF_RECORDS_DIRECTORY);
    this.invalidationsDirectory = join(
      this.directory,
      PUBLIC_LAUNCH_HANDOFF_INVALIDATIONS_DIRECTORY,
    );
  }

  async initialize(): Promise<void> {
    const root = await inspectHandoffRoot(this.directory, "public launch handoff directory");
    if (root === null) {
      throw new Error("public launch handoff directory must be pre-provisioned by tmpfiles");
    }
    if (root.uid !== currentUid()) {
      throw new Error("public launch handoff directory is not owned by the Control service uid");
    }
    const rootIdentity = Object.freeze({ uid: root.uid, gid: root.gid });
    await createSharedChildDirectory(
      this.recordsDirectory,
      "public launch handoff records directory",
      rootIdentity,
    );
    await createSharedChildDirectory(
      this.invalidationsDirectory,
      "public launch handoff invalidations directory",
      rootIdentity,
    );
  }

  async #readPointerState(): Promise<PublicLaunchHandoffPointerState> {
    const root = await inspectHandoffRoot(this.directory, "public launch handoff directory");
    if (root === null) {
      return Object.freeze({ state: "EMPTY" });
    }
    const rawPointer = await readStrictFile(
      join(this.directory, PUBLIC_LAUNCH_HANDOFF_CURRENT_FILENAME),
      "public launch handoff current pointer",
    );
    if (rawPointer === null) return Object.freeze({ state: "EMPTY" });
    const raw = object(rawPointer, "public launch handoff current pointer");
    if (raw.kind === "INVALIDATED_PUBLIC_LAUNCH_HANDOFF") {
      const pointer = parseInvalidatedPointer(raw);
      if (
        (await inspectDirectory(
          this.invalidationsDirectory,
          "public launch handoff invalidations directory",
          root,
        )) === null
      ) {
        throw new Error("public launch handoff invalidations directory is missing");
      }
      const rawInvalidation = await readStrictFile(
        join(this.invalidationsDirectory, pointer.invalidationFilename),
        "public launch handoff immutable invalidation",
      );
      if (rawInvalidation === null) {
        throw new Error("public launch handoff immutable invalidation is missing");
      }
      const invalidation = parseInvalidation(rawInvalidation);
      if (
        pointer.invalidationId !== invalidation.invalidationId ||
        pointer.invalidationHash !== stableHash(invalidation) ||
        pointer.handoffId !== invalidation.handoffId ||
        pointer.recordFilename !== invalidation.recordFilename ||
        pointer.recordHash !== invalidation.recordHash
      ) {
        throw new Error("public launch handoff invalidated pointer does not match its tombstone");
      }
      if (
        (await inspectDirectory(
          this.recordsDirectory,
          "public launch handoff records directory",
          root,
        )) === null
      ) {
        throw new Error("public launch handoff records directory is missing");
      }
      const rawRecord = await readStrictFile(
        join(this.recordsDirectory, pointer.recordFilename),
        "public launch handoff invalidated immutable record",
      );
      if (rawRecord === null) {
        throw new Error("public launch handoff invalidated immutable record is missing");
      }
      const record = parsePublicLaunchHandoffRecord(rawRecord);
      if (record.handoffId !== pointer.handoffId || stableHash(record) !== pointer.recordHash) {
        throw new Error("public launch handoff tombstone does not match its immutable record");
      }
      return Object.freeze({ state: "INVALIDATED", pointer, invalidation });
    }
    return Object.freeze({ state: "ACTIVE", pointer: parsePointer(raw) });
  }

  async readInvalidation(): Promise<PublicLaunchHandoffInvalidation | null> {
    const state = await this.#readPointerState();
    return state.state === "INVALIDATED" ? state.invalidation : null;
  }

  async readCurrent(): Promise<PublicLaunchHandoffRecord | null> {
    const state = await this.#readPointerState();
    if (state.state !== "ACTIVE") return null;
    const root = await inspectHandoffRoot(this.directory, "public launch handoff directory");
    if (root === null) throw new Error("public launch handoff directory is missing");
    if (
      (await inspectDirectory(
        this.recordsDirectory,
        "public launch handoff records directory",
        root,
      )) === null
    ) {
      throw new Error("public launch handoff records directory is missing");
    }
    const pointer = state.pointer;
    const rawRecord = await readStrictFile(
      join(this.recordsDirectory, pointer.recordFilename),
      "public launch handoff immutable record",
    );
    if (rawRecord === null) throw new Error("public launch handoff immutable record is missing");
    const record = parsePublicLaunchHandoffRecord(rawRecord);
    if (
      pointer.handoffId !== record.handoffId ||
      pointer.recordHash !== stableHash(record) ||
      pointer.profileHash !== record.profileHash
    ) {
      throw new Error("public launch handoff current pointer does not match its record");
    }
    return record;
  }

  async readCursor(): Promise<PublicLaunchHandoffCursor | null> {
    if ((await inspectHandoffRoot(this.directory, "public launch handoff directory")) === null) {
      return null;
    }
    const raw = await readStrictFile(
      join(this.directory, PUBLIC_LAUNCH_HANDOFF_CURSOR_FILENAME),
      "public launch handoff cursor",
    );
    return raw === null ? null : parseCursor(raw);
  }

  async commitCursor(
    lastCompletedBlock: bigint,
    updatedAt = new Date().toISOString(),
  ): Promise<void> {
    if (lastCompletedBlock < 0n) throw new RangeError("handoff cursor cannot be negative");
    const cursor = parseCursor({
      formatVersion: 1,
      kind: "PUBLIC_SAFE_LAUNCH_CURSOR",
      profileHash: PUBLIC_LAUNCH_HANDOFF_PROFILE_HASH,
      lastCompletedBlock: lastCompletedBlock.toString(),
      updatedAt,
    });
    await atomicReplace(join(this.directory, PUBLIC_LAUNCH_HANDOFF_CURSOR_FILENAME), cursor);
  }

  async #writeActiveSignal(current: PublicLaunchHandoffRecord, updatedAt: string): Promise<void> {
    const signal: PublicLaunchHandoffActiveSignal = Object.freeze({
      formatVersion: 1,
      kind: "ACTIVE_PUBLIC_LAUNCH_HANDOFF_SIGNAL",
      profileHash: current.profileHash,
      handoffId: current.handoffId,
      recordHash: stableHash(current),
      updatedAt: iso(updatedAt, "public launch handoff signal time"),
    });
    await atomicReplace(join(this.directory, PUBLIC_LAUNCH_HANDOFF_ACTIVE_SIGNAL_FILENAME), signal);
  }

  /**
   * Emit a valid-only activation signal without changing current.json. Control
   * uses this once on startup so an already-discovered canonical launch is
   * replayed to a PathChanged unit after a host reboot. Reorg tombstones never
   * touch this file, so an invalidation cannot consume the executor start limit.
   */
  async signalCurrent(
    updatedAt = new Date().toISOString(),
  ): Promise<PublicLaunchHandoffRecord | null> {
    const current = await this.readCurrent();
    if (current === null) return null;
    await this.#writeActiveSignal(current, updatedAt);
    const installed = await this.readCurrent();
    if (installed === null || installed.handoffId !== current.handoffId) {
      throw new Error("public launch handoff startup signal changed the current record");
    }
    return installed;
  }

  /**
   * Invalidate exactly the expected current record after the public node has
   * returned a different canonical hash for its height. The immutable record
   * and immutable tombstone are retained; current.json becomes an auditable
   * tombstone pointer instead of being deleted.
   */
  async invalidateCurrentForReorg(input: {
    readonly expected: PublicLaunchHandoffRecord;
    readonly observedCanonicalBlockHash: string;
    readonly rewindToBlock: bigint;
    readonly observedAt?: string;
  }): Promise<PublicLaunchHandoffInvalidation> {
    const expected = parsePublicLaunchHandoffRecord(input.expected);
    const observedCanonicalBlockHash = hex32(
      input.observedCanonicalBlockHash,
      "observed canonical blockHash",
    );
    if (observedCanonicalBlockHash.toLowerCase() === expected.created.blockHash.toLowerCase()) {
      throw new Error("cannot invalidate a public handoff whose block is still canonical");
    }
    if (input.rewindToBlock < 0n || input.rewindToBlock >= BigInt(expected.created.blockNumber)) {
      throw new RangeError("public handoff reorg rewind must precede the created block");
    }
    const before = await this.#readPointerState();
    if (before.state !== "ACTIVE" || before.pointer.handoffId !== expected.handoffId) {
      throw new Error("public handoff reorg invalidation CAS did not match current");
    }
    if (
      before.pointer.recordHash !== stableHash(expected) ||
      before.pointer.recordFilename !== recordFilename(expected)
    ) {
      throw new Error("public handoff reorg invalidation CAS record binding failed");
    }
    const observedAt = iso(
      input.observedAt ?? new Date().toISOString(),
      "public handoff reorg observation time",
    );
    const identityInput = {
      profileHash: PUBLIC_LAUNCH_HANDOFF_PROFILE_HASH,
      handoffId: expected.handoffId,
      recordHash: stableHash(expected),
      blockNumber: expected.created.blockNumber,
      expectedBlockHash: expected.created.blockHash.toLowerCase(),
      observedCanonicalBlockHash: observedCanonicalBlockHash.toLowerCase(),
      rewindToBlock: input.rewindToBlock.toString(),
    };
    const invalidationId = `reorg-${stableHash(identityInput).slice("sha256:".length)}`;
    const invalidation = parseInvalidation({
      formatVersion: 1,
      kind: "PUBLIC_LAUNCH_HANDOFF_REORG_INVALIDATION",
      profileHash: PUBLIC_LAUNCH_HANDOFF_PROFILE_HASH,
      invalidationId,
      handoffId: expected.handoffId,
      recordFilename: recordFilename(expected),
      recordHash: stableHash(expected),
      blockNumber: expected.created.blockNumber,
      expectedBlockHash: expected.created.blockHash,
      observedCanonicalBlockHash,
      rewindToBlock: input.rewindToBlock.toString(),
      observedAt,
    });
    const invalidationFilename = `${invalidation.invalidationId}.json`;
    const invalidationPath = join(this.invalidationsDirectory, invalidationFilename);
    try {
      await writeFile(invalidationPath, `${JSON.stringify(invalidation, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o640,
        flag: "wx",
      });
      await chmod(invalidationPath, 0o640);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readStrictFile(
        invalidationPath,
        "public launch handoff immutable invalidation",
      );
      if (
        existing === null ||
        stableHash(parseInvalidation(existing)) !== stableHash(invalidation)
      ) {
        throw new Error("immutable public launch handoff invalidation collision");
      }
    }
    const checked = await this.#readPointerState();
    if (
      checked.state !== "ACTIVE" ||
      checked.pointer.handoffId !== before.pointer.handoffId ||
      stableHash(checked.pointer) !== stableHash(before.pointer)
    ) {
      throw new Error("public handoff reorg invalidation lost its CAS race");
    }
    const tombstonePointer: PublicLaunchHandoffInvalidatedPointer = Object.freeze({
      formatVersion: 1,
      kind: "INVALIDATED_PUBLIC_LAUNCH_HANDOFF",
      profileHash: PUBLIC_LAUNCH_HANDOFF_PROFILE_HASH,
      handoffId: expected.handoffId,
      recordFilename: recordFilename(expected),
      recordHash: stableHash(expected),
      invalidationId: invalidation.invalidationId,
      invalidationFilename,
      invalidationHash: stableHash(invalidation),
      updatedAt: observedAt,
    });
    await this.commitCursor(input.rewindToBlock, observedAt);
    await atomicReplace(
      join(this.directory, PUBLIC_LAUNCH_HANDOFF_CURRENT_FILENAME),
      tombstonePointer,
    );
    const installed = await this.#readPointerState();
    if (
      installed.state !== "INVALIDATED" ||
      installed.invalidation.invalidationId !== invalidation.invalidationId
    ) {
      throw new Error("public launch handoff reorg tombstone was not installed");
    }
    return installed.invalidation;
  }

  async publish(record: PublicLaunchHandoffRecord): Promise<PublicLaunchHandoffPublishResult> {
    const canonical = parsePublicLaunchHandoffRecord(record);
    const filename = recordFilename(canonical);
    const target = join(this.recordsDirectory, filename);
    const payload = `${JSON.stringify(canonical, null, 2)}\n`;
    let immutableRecord = canonical;
    try {
      await writeFile(target, payload, { encoding: "utf8", mode: 0o640, flag: "wx" });
      await chmod(target, 0o640);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readStrictFile(target, "public launch handoff immutable record");
      if (existing === null) {
        throw new Error("immutable public launch handoff record collision");
      }
      immutableRecord = parsePublicLaunchHandoffRecord(existing);
      if (immutableRecord.handoffId !== canonical.handoffId) {
        throw new Error("immutable public launch handoff record collision");
      }
    }

    const pointerState = await this.#readPointerState();
    const current = await this.readCurrent();
    if (pointerState.state === "ACTIVE" && current !== null) {
      if (current.handoffId === immutableRecord.handoffId) {
        // A duplicate here means the pointer was installed but the durable
        // cursor was not committed (for example, a crash between those two
        // operations). Re-signal the valid record to close that crash gap.
        await this.#writeActiveSignal(current, immutableRecord.observedAt);
        return Object.freeze({ state: "DUPLICATE", record: current });
      }
      return Object.freeze({ state: "CONFLICT", record: immutableRecord, current });
    }

    const pointer: PublicLaunchHandoffPointer = Object.freeze({
      formatVersion: 1,
      kind: "CURRENT_PUBLIC_LAUNCH_HANDOFF",
      profileHash: PUBLIC_LAUNCH_HANDOFF_PROFILE_HASH,
      handoffId: immutableRecord.handoffId,
      recordFilename: filename,
      recordHash: stableHash(immutableRecord),
      updatedAt: immutableRecord.observedAt,
    });
    if (pointerState.state === "INVALIDATED") {
      const checked = await this.#readPointerState();
      if (
        checked.state !== "INVALIDATED" ||
        checked.invalidation.invalidationId !== pointerState.invalidation.invalidationId
      ) {
        throw new Error("replacement public handoff lost its tombstone CAS race");
      }
      await atomicReplace(join(this.directory, PUBLIC_LAUNCH_HANDOFF_CURRENT_FILENAME), pointer);
    } else {
      const temporary = join(this.directory, `.current.${process.pid}.${Date.now()}.tmp`);
      await writeFile(temporary, `${JSON.stringify(pointer, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o640,
        flag: "wx",
      });
      try {
        await chmod(temporary, 0o640);
        await link(temporary, join(this.directory, PUBLIC_LAUNCH_HANDOFF_CURRENT_FILENAME));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    }
    const installed = await this.readCurrent();
    if (installed === null)
      throw new Error("public launch handoff current pointer was not installed");
    if (installed.handoffId === immutableRecord.handoffId) {
      await this.#writeActiveSignal(installed, immutableRecord.observedAt);
      return Object.freeze({ state: "CREATED", record: installed });
    }
    return Object.freeze({ state: "CONFLICT", record: immutableRecord, current: installed });
  }
}

export async function readCurrentPublicLaunchHandoff(
  directory = PUBLIC_LAUNCH_HANDOFF_DEFAULT_DIRECTORY,
): Promise<PublicLaunchHandoffRecord | null> {
  return await new PublicLaunchHandoffStore(directory).readCurrent();
}
