import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type ProductionServiceName = "control" | "executor" | "reconciler" | "exit";
export type ProductionServiceState =
  | "BOOTING"
  | "WATCHING"
  | "READY"
  | "ACTIVE"
  | "DEGRADED"
  | "STOPPING"
  | "FAILED";

export interface ProductionServiceStatus {
  readonly formatVersion: 1;
  readonly service: ProductionServiceName;
  readonly state: ProductionServiceState;
  readonly pid: number;
  readonly ownerId: string;
  readonly sequence: number;
  readonly observedAt: string;
  readonly profileId?: string;
  readonly profileRevision?: number;
  readonly profileHash?: string;
  readonly authorizationId?: string;
  readonly authorizationExpiresAt?: string;
  readonly signerReady: number;
  readonly database: Readonly<{
    schemaVersion: number;
    walEnabled: boolean;
    leaseOwned: boolean;
  }>;
  readonly entryEnabled: boolean;
  readonly exitEnabled: boolean;
  readonly unresolvedAttemptCount: number;
  readonly openPositionCount: number;
  readonly verifiedExitRouteCount: number;
  readonly details: readonly string[];
}

function statusFilename(service: ProductionServiceName): string {
  return `${service}-status.json`;
}

export async function writeProductionServiceStatus(
  directory: string,
  status: ProductionServiceStatus,
): Promise<void> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o750 });
  const target = join(root, statusFilename(status.service));
  const temporary = join(root, `.${status.service}-status.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o640,
  });
  await chmod(temporary, 0o640);
  await rename(temporary, target);
}

export type ProductionServiceReadback =
  | Readonly<{ state: "CURRENT"; status: ProductionServiceStatus; ageMs: number }>
  | Readonly<{
      state: "MISSING" | "INVALID" | "STALE";
      reason: string;
      status?: ProductionServiceStatus;
    }>;

export async function readProductionServiceStatus(
  directory: string,
  service: ProductionServiceName,
  maximumAgeMs: number,
  nowMs = Date.now(),
): Promise<ProductionServiceReadback> {
  if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs <= 0) {
    throw new RangeError("maximumAgeMs must be a positive safe integer");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(resolve(directory), statusFilename(service)), "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return Object.freeze({
      state: code === "ENOENT" ? "MISSING" : "INVALID",
      reason:
        code === "ENOENT" ? `${service} status is missing` : `${service} status cannot be read`,
    });
  }
  if (
    value === null ||
    typeof value !== "object" ||
    (value as Partial<ProductionServiceStatus>).formatVersion !== 1 ||
    (value as Partial<ProductionServiceStatus>).service !== service ||
    typeof (value as Partial<ProductionServiceStatus>).observedAt !== "string"
  ) {
    return Object.freeze({ state: "INVALID", reason: `${service} status schema is invalid` });
  }
  const status = value as ProductionServiceStatus;
  const observedMs = Date.parse(status.observedAt);
  if (!Number.isFinite(observedMs)) {
    return Object.freeze({ state: "INVALID", reason: `${service} status time is invalid` });
  }
  const ageMs = Math.max(0, nowMs - observedMs);
  if (ageMs > maximumAgeMs) {
    return Object.freeze({ state: "STALE", reason: `${service} status is stale`, status });
  }
  return Object.freeze({ state: "CURRENT", status, ageMs });
}

export async function assertExecutorDependenciesReady(input: {
  readonly directory: string;
  readonly profileHash: string;
  readonly authorizationId: string;
  readonly expectedSignerCount: number;
  readonly maximumAgeMs?: number;
  readonly nowMs?: number;
}): Promise<void> {
  const maximumAgeMs = input.maximumAgeMs ?? 15_000;
  const nowMs = input.nowMs ?? Date.now();
  const [reconciler, exit] = await Promise.all([
    readProductionServiceStatus(input.directory, "reconciler", maximumAgeMs, nowMs),
    readProductionServiceStatus(input.directory, "exit", maximumAgeMs, nowMs),
  ]);
  if (reconciler.state !== "CURRENT") {
    throw new Error(`executor dependency is unavailable: ${reconciler.reason}`);
  }
  if (exit.state !== "CURRENT") {
    throw new Error(`executor dependency is unavailable: ${exit.reason}`);
  }
  if (!["READY", "ACTIVE"].includes(reconciler.status.state)) {
    throw new Error(`reconciler is not ready: ${reconciler.status.state}`);
  }
  if (!["READY", "ACTIVE"].includes(exit.status.state)) {
    throw new Error(`exit service is not ready: ${exit.status.state}`);
  }
  if (!reconciler.status.database.walEnabled || !exit.status.database.walEnabled) {
    throw new Error("executor dependencies do not share WAL-backed canonical state");
  }
  if (reconciler.status.unresolvedAttemptCount !== 0 || exit.status.unresolvedAttemptCount !== 0) {
    throw new Error("unresolved attempts block new entry dispatch");
  }
  if (
    exit.status.profileHash !== input.profileHash ||
    exit.status.authorizationId !== input.authorizationId
  ) {
    throw new Error("exit service profile or authorization does not match the executor");
  }
  if (
    exit.status.signerReady !== input.expectedSignerCount ||
    !exit.status.exitEnabled ||
    !reconciler.status.exitEnabled
  ) {
    throw new Error("exit or reconciliation capability is not ready for every signer");
  }
}

export function emptyProductionServiceStatus(input: {
  readonly service: ProductionServiceName;
  readonly state: ProductionServiceState;
  readonly ownerId: string;
  readonly sequence: number;
  readonly details?: readonly string[];
  readonly now?: string;
}): ProductionServiceStatus {
  return Object.freeze({
    formatVersion: 1,
    service: input.service,
    state: input.state,
    pid: process.pid,
    ownerId: input.ownerId,
    sequence: input.sequence,
    observedAt: input.now ?? new Date().toISOString(),
    signerReady: 0,
    database: Object.freeze({ schemaVersion: 0, walEnabled: false, leaseOwned: false }),
    entryEnabled: false,
    exitEnabled: false,
    unresolvedAttemptCount: 0,
    openPositionCount: 0,
    verifiedExitRouteCount: 0,
    details: Object.freeze([...(input.details ?? [])]),
  });
}
