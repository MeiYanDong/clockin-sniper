import { CanonicalInvariantError, stableHash } from "../core/canonical.js";

export type CapScope = "PER_TX" | "PER_WALLET" | "GLOBAL" | "NO_CAP" | "UNKNOWN";
export type CooldownScope = "PER_WALLET" | "GLOBAL" | "NONE" | "UNKNOWN";

export interface MechanismSnapshot {
  readonly factoryCodeHash: `0x${string}`;
  readonly poolCodeHash: `0x${string}`;
  readonly initialFeeBps: number;
  readonly floorFeeBps: number;
  readonly decayWindowSeconds: number;
  readonly decayModel: "LINEAR_TIME" | "PIECEWISE_TIME" | "PER_BLOCK" | "UNKNOWN";
  readonly inSniperWindow: boolean;
  readonly buyCooldownSeconds: number;
  readonly cooldownScope: CooldownScope;
  readonly eoaOnlySeconds: number;
  readonly windowMaxBuyBps: number;
  readonly currentWindowCapRaw: bigint;
  readonly capScope: CapScope;
  readonly quoteAsset: `0x${string}`;
  readonly getterEvidenceIds: readonly string[];
}

export type MechanismKind =
  | "CLOCKIN_40PCT_2MIN_V1"
  | "SAFE_LAUNCH_99PCT_99MIN"
  | "CUSTOM_OR_UNKNOWN";

export interface MechanismProfile {
  readonly profileId: string;
  readonly revision: number;
  readonly kind: MechanismKind;
  readonly snapshot: MechanismSnapshot;
  readonly supportedForClockInStrategy: boolean;
  readonly evidenceIds: readonly string[];
}

export type MechanismGetterName =
  | "factoryCodeHash"
  | "poolCodeHash"
  | "initialFeeBps"
  | "floorFeeBps"
  | "decayWindowSeconds"
  | "decayModel"
  | "inSniperWindow"
  | "buyCooldownSeconds"
  | "cooldownScope"
  | "eoaOnlySeconds"
  | "windowMaxBuyBps"
  | "currentWindowCapRaw"
  | "capScope"
  | "quoteAsset";

export interface MechanismGetterReader {
  readonly evidenceId: string;
  read(name: MechanismGetterName, blockNumber: bigint): Promise<unknown>;
}

function integer(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CanonicalInvariantError(
      "MECHANISM_GETTER_ERROR",
      `${name} getter returned a non-integer value`,
    );
  }
  return value;
}

function text<T extends string>(name: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new CanonicalInvariantError(
      "MECHANISM_GETTER_ERROR",
      `${name} getter returned an unsupported value`,
    );
  }
  return value as T;
}

export async function readMechanismSnapshot(
  reader: MechanismGetterReader,
  blockNumber: bigint,
): Promise<MechanismSnapshot> {
  if (blockNumber < 0n) throw new RangeError("mechanism block number cannot be negative");
  const names = [
    "factoryCodeHash",
    "poolCodeHash",
    "initialFeeBps",
    "floorFeeBps",
    "decayWindowSeconds",
    "decayModel",
    "inSniperWindow",
    "buyCooldownSeconds",
    "cooldownScope",
    "eoaOnlySeconds",
    "windowMaxBuyBps",
    "currentWindowCapRaw",
    "capScope",
    "quoteAsset",
  ] as const;
  const values = new Map<MechanismGetterName, unknown>();
  try {
    await Promise.all(
      names.map(async (name) => {
        values.set(name, await reader.read(name, blockNumber));
      }),
    );
  } catch (error) {
    throw new CanonicalInvariantError(
      "MECHANISM_GETTER_ERROR",
      `mechanism getter reverted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const booleanValue = values.get("inSniperWindow");
  const cap = values.get("currentWindowCapRaw");
  if (typeof booleanValue !== "boolean") {
    throw new CanonicalInvariantError(
      "MECHANISM_GETTER_ERROR",
      "inSniperWindow getter returned a non-boolean value",
    );
  }
  if (typeof cap !== "bigint" || cap < 0n) {
    throw new CanonicalInvariantError(
      "MECHANISM_GETTER_ERROR",
      "currentWindowCapRaw getter returned an invalid bigint",
    );
  }
  const factoryCodeHash = values.get("factoryCodeHash");
  const poolCodeHash = values.get("poolCodeHash");
  const quoteAsset = values.get("quoteAsset");
  if (
    typeof factoryCodeHash !== "string" ||
    typeof poolCodeHash !== "string" ||
    typeof quoteAsset !== "string"
  ) {
    throw new CanonicalInvariantError(
      "MECHANISM_GETTER_ERROR",
      "code hash or quote getter returned an invalid type",
    );
  }
  const snapshot: MechanismSnapshot = Object.freeze({
    factoryCodeHash: factoryCodeHash as `0x${string}`,
    poolCodeHash: poolCodeHash as `0x${string}`,
    initialFeeBps: integer("initialFeeBps", values.get("initialFeeBps")),
    floorFeeBps: integer("floorFeeBps", values.get("floorFeeBps")),
    decayWindowSeconds: integer("decayWindowSeconds", values.get("decayWindowSeconds")),
    decayModel: text("decayModel", values.get("decayModel"), [
      "LINEAR_TIME",
      "PIECEWISE_TIME",
      "PER_BLOCK",
      "UNKNOWN",
    ]),
    inSniperWindow: booleanValue,
    buyCooldownSeconds: integer("buyCooldownSeconds", values.get("buyCooldownSeconds")),
    cooldownScope: text("cooldownScope", values.get("cooldownScope"), [
      "PER_WALLET",
      "GLOBAL",
      "NONE",
      "UNKNOWN",
    ]),
    eoaOnlySeconds: integer("eoaOnlySeconds", values.get("eoaOnlySeconds")),
    windowMaxBuyBps: integer("windowMaxBuyBps", values.get("windowMaxBuyBps")),
    currentWindowCapRaw: cap,
    capScope: text("capScope", values.get("capScope"), [
      "PER_TX",
      "PER_WALLET",
      "GLOBAL",
      "NO_CAP",
      "UNKNOWN",
    ]),
    quoteAsset: quoteAsset as `0x${string}`,
    getterEvidenceIds: [reader.evidenceId],
  });
  profileMechanism(snapshot);
  return snapshot;
}

function validateBps(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new RangeError(`${name} must be an integer between 0 and 10000`);
  }
}

export function profileMechanism(snapshot: MechanismSnapshot): MechanismProfile {
  validateBps("initialFeeBps", snapshot.initialFeeBps);
  validateBps("floorFeeBps", snapshot.floorFeeBps);
  if (snapshot.floorFeeBps > snapshot.initialFeeBps) {
    throw new RangeError("floor fee exceeds initial fee");
  }
  if (!Number.isSafeInteger(snapshot.decayWindowSeconds) || snapshot.decayWindowSeconds <= 0) {
    throw new RangeError("decay window must be positive");
  }
  let kind: MechanismKind = "CUSTOM_OR_UNKNOWN";
  if (
    snapshot.initialFeeBps <= 4_000 &&
    snapshot.decayWindowSeconds >= 90 &&
    snapshot.decayWindowSeconds <= 180 &&
    snapshot.decayModel === "LINEAR_TIME"
  ) {
    kind = "CLOCKIN_40PCT_2MIN_V1";
  } else if (
    snapshot.initialFeeBps >= 9_900 &&
    snapshot.decayWindowSeconds >= 5_900 &&
    snapshot.decayWindowSeconds <= 6_000
  ) {
    kind = "SAFE_LAUNCH_99PCT_99MIN";
  }
  return Object.freeze({
    profileId: `mechanism:${stableHash({
      ...snapshot,
      currentWindowCapRaw: snapshot.currentWindowCapRaw.toString(),
    })}`,
    revision: 1,
    kind,
    snapshot,
    supportedForClockInStrategy: kind === "CLOCKIN_40PCT_2MIN_V1",
    evidenceIds: Object.freeze([...snapshot.getterEvidenceIds]),
  });
}

export function assertClockInMechanism(profile: MechanismProfile): void {
  if (!profile.supportedForClockInStrategy) {
    throw new CanonicalInvariantError(
      "PROFILE_UNSUPPORTED",
      `mechanism ${profile.kind} is unsupported for the ClockIn ten-band strategy`,
    );
  }
}
