import type { SqliteStore } from "../persistence/sqlite-store.js";

export type DeploymentRole = "ACTIVE_EXECUTOR" | "OBSERVER";

export interface FailoverAuditInput {
  readonly unknownAttemptCount: number;
  readonly walletNonces: readonly {
    readonly walletId: string;
    readonly latestNonce: bigint;
    readonly pendingNonce: bigint;
  }[];
  readonly canonicalDatabaseAvailable: boolean;
  readonly signedVaultAvailable: boolean;
}

export interface DeploymentLease {
  readonly role: DeploymentRole;
  readonly ownerId: string;
  readonly fencingEpoch?: number;
  readonly signingAllowed: boolean;
  readonly newEntryAllowed: boolean;
  readonly reasons: readonly string[];
}

export function acquireDeploymentRole(input: {
  readonly store: SqliteStore;
  readonly role: DeploymentRole;
  readonly ownerId: string;
  readonly hasSignerCredentials: boolean;
  readonly leaseExpiresAt: string;
  readonly now: string;
  readonly takeoverAudit?: FailoverAuditInput;
}): DeploymentLease {
  if (input.role === "OBSERVER") {
    if (input.hasSignerCredentials) throw new Error("observer must not receive signer credentials");
    return Object.freeze({
      role: input.role,
      ownerId: input.ownerId,
      signingAllowed: false,
      newEntryAllowed: false,
      reasons: Object.freeze(["observer is evidence-only and holds no writer lease"]),
    });
  }
  if (!input.hasSignerCredentials)
    throw new Error("active executor has no signer credential source");
  const reasons: string[] = [];
  let newEntryAllowed = true;
  if (input.takeoverAudit !== undefined) {
    if (input.takeoverAudit.unknownAttemptCount > 0) {
      reasons.push("open UNKNOWN attempts require reconciliation before new entry");
      newEntryAllowed = false;
    }
    if (
      input.takeoverAudit.walletNonces.some((nonce) => nonce.latestNonce !== nonce.pendingNonce)
    ) {
      reasons.push("latest/pending nonce disagreement requires reconciliation");
      newEntryAllowed = false;
    }
    if (!input.takeoverAudit.canonicalDatabaseAvailable) {
      throw new Error("controlled takeover requires the canonical database");
    }
    if (!input.takeoverAudit.signedVaultAvailable) {
      reasons.push("signed vault unavailable; UNKNOWN recovery cannot rebroadcast exact raw");
      newEntryAllowed = false;
    }
  }
  const fencingEpoch = input.store.acquireServiceLease(
    "clockin:active-executor",
    input.ownerId,
    input.leaseExpiresAt,
    input.now,
  );
  return Object.freeze({
    role: input.role,
    ownerId: input.ownerId,
    fencingEpoch,
    signingAllowed: true,
    newEntryAllowed,
    reasons: Object.freeze(reasons),
  });
}
