import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type ProductionServiceName = "control" | "executor" | "reconciler" | "exit";
export type ExecutorDependencyTier = "BOUNDED_CANARY" | "FULL_DEPLOYMENT";
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

function statusTier(service: ProductionServiceName): "control" | "paid" {
  return service === "control" ? "control" : "paid";
}

function statusDirectory(directory: string, service: ProductionServiceName): string {
  return join(resolve(directory), statusTier(service));
}

async function assertSecureDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`status directory is not a real directory: ${path}`);
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error(`status directory is group- or world-writable: ${path}`);
  }
}

async function ensureSecureStatusDirectory(
  directory: string,
  service: ProductionServiceName,
): Promise<string> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o750 });
  await assertSecureDirectory(root);
  const routed = statusDirectory(directory, service);
  await mkdir(routed, { recursive: true, mode: 0o750 });
  await assertSecureDirectory(routed);
  return routed;
}

async function assertSecureStatusFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("status path is not a regular file");
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error("status file is group- or world-writable");
  }
}

export async function writeProductionServiceStatus(
  directory: string,
  status: ProductionServiceStatus,
): Promise<void> {
  const root = await ensureSecureStatusDirectory(directory, status.service);
  const target = join(root, statusFilename(status.service));
  try {
    await assertSecureStatusFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(
    root,
    `.${status.service}-status.${process.pid}.${randomBytes(16).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o640,
      flag: "wx",
    });
    await chmod(temporary, 0o640);
    await assertSecureStatusFile(temporary);
    await rename(temporary, target);
    await assertSecureStatusFile(target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
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
  const routedDirectory = statusDirectory(directory, service);
  const target = join(routedDirectory, statusFilename(service));
  let value: unknown;
  try {
    await assertSecureDirectory(resolve(directory));
    await assertSecureDirectory(routedDirectory);
    await assertSecureStatusFile(target);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || (metadata.mode & 0o022) !== 0) {
        throw new Error("status file descriptor is not a secure regular file");
      }
      value = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    } finally {
      await handle.close();
    }
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

export interface ExecutorDependencyReadiness {
  readonly canaryReady: boolean;
  readonly fullDeploymentReady: boolean;
  readonly canaryReasons: readonly string[];
  readonly fullDeploymentReasons: readonly string[];
}

export async function inspectExecutorDependencies(input: {
  readonly directory: string;
  readonly profileHash: string;
  readonly authorizationId: string;
  readonly expectedSignerCount: number;
  readonly maximumAgeMs?: number;
  readonly nowMs?: number;
}): Promise<ExecutorDependencyReadiness> {
  const maximumAgeMs = input.maximumAgeMs ?? 15_000;
  const nowMs = input.nowMs ?? Date.now();
  const [reconciler, exit] = await Promise.all([
    readProductionServiceStatus(input.directory, "reconciler", maximumAgeMs, nowMs),
    readProductionServiceStatus(input.directory, "exit", maximumAgeMs, nowMs),
  ]);
  const canaryReasons: string[] = [];
  if (reconciler.state !== "CURRENT") {
    canaryReasons.push(`executor dependency is unavailable: ${reconciler.reason}`);
  } else {
    if (!["READY", "ACTIVE"].includes(reconciler.status.state)) {
      canaryReasons.push(`reconciler is not ready: ${reconciler.status.state}`);
    }
    if (!reconciler.status.database.walEnabled) {
      canaryReasons.push("reconciler does not expose WAL-backed canonical state");
    }
    if (reconciler.status.unresolvedAttemptCount !== 0) {
      canaryReasons.push("unresolved attempts block new entry dispatch");
    }
  }

  const fullDeploymentReasons = [...canaryReasons];
  if (exit.state !== "CURRENT") {
    fullDeploymentReasons.push(`executor dependency is unavailable: ${exit.reason}`);
  } else {
    if (!["READY", "ACTIVE"].includes(exit.status.state)) {
      fullDeploymentReasons.push(`exit service is not ready: ${exit.status.state}`);
    }
    if (!exit.status.database.walEnabled) {
      fullDeploymentReasons.push("exit service does not expose WAL-backed canonical state");
    }
    if (exit.status.unresolvedAttemptCount !== 0) {
      fullDeploymentReasons.push("unresolved attempts block new entry dispatch");
    }
    if (
      exit.status.profileHash !== input.profileHash ||
      exit.status.authorizationId !== input.authorizationId
    ) {
      fullDeploymentReasons.push(
        "exit service profile or authorization does not match the executor",
      );
    }
    if (exit.status.signerReady !== input.expectedSignerCount) {
      fullDeploymentReasons.push("exit capability is not ready for every signer");
    }
    if (
      !exit.status.exitEnabled ||
      reconciler.state !== "CURRENT" ||
      !reconciler.status.exitEnabled
    ) {
      fullDeploymentReasons.push("exit or reconciliation capability is disabled");
    }
    if (exit.status.verifiedExitRouteCount < 1) {
      fullDeploymentReasons.push("no verified executable exit route is ready");
    }
  }
  return Object.freeze({
    canaryReady: canaryReasons.length === 0,
    fullDeploymentReady: fullDeploymentReasons.length === 0,
    canaryReasons: Object.freeze(canaryReasons),
    fullDeploymentReasons: Object.freeze(fullDeploymentReasons),
  });
}

export async function assertExecutorDependenciesReady(input: {
  readonly directory: string;
  readonly profileHash: string;
  readonly authorizationId: string;
  readonly expectedSignerCount: number;
  readonly tier?: ExecutorDependencyTier;
  readonly maximumAgeMs?: number;
  readonly nowMs?: number;
}): Promise<void> {
  const readiness = await inspectExecutorDependencies(input);
  const tier = input.tier ?? "FULL_DEPLOYMENT";
  const reasons =
    tier === "BOUNDED_CANARY" ? readiness.canaryReasons : readiness.fullDeploymentReasons;
  if (reasons.length > 0) {
    throw new Error(`${tier} dependencies are not ready: ${reasons.join("; ")}`);
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
