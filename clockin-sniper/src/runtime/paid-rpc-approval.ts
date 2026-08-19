import { readFile, stat } from "node:fs/promises";

export const PAID_RPC_APPROVAL_PATH = "/etc/clockin-sniper/PAID_RPC_APPROVED";
export const PAID_RPC_APPROVAL_VALUE = "CLOCKIN_PAID_RPC_APPROVED_V1";

export interface PaidRpcApprovalMetadata {
  readonly isFile: boolean;
  readonly uid: number;
  readonly gid: number;
  readonly expectedPaidServiceGid: number;
  readonly mode: number;
}

export function validatePaidRpcApproval(content: string, metadata: PaidRpcApprovalMetadata): void {
  if (!metadata.isFile) throw new Error("paid RPC approval marker is not a regular file");
  if (metadata.uid !== 0) throw new Error("paid RPC approval marker must be owned by root");
  if (metadata.gid !== metadata.expectedPaidServiceGid) {
    throw new Error("paid RPC approval marker must be grouped to the paid service");
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error("paid RPC approval marker must not be group/world writable");
  }
  if ((metadata.mode & 0o777) !== 0o440) {
    throw new Error("paid RPC approval marker must have exact mode 0440");
  }
  if (content.trim() !== PAID_RPC_APPROVAL_VALUE) {
    throw new Error("paid RPC approval marker has an invalid value");
  }
}

/**
 * This check runs before a paid endpoint credential is read. The marker only
 * authorizes paid transport cost during a deliberate real-snipe/recovery
 * window; it does not authorize signing or broadcasting.
 */
export async function assertPaidRpcApproved(): Promise<void> {
  if (process.getgid === undefined) {
    throw new Error("paid RPC approval requires a POSIX paid-service group");
  }
  const [content, file] = await Promise.all([
    readFile(PAID_RPC_APPROVAL_PATH, "utf8"),
    stat(PAID_RPC_APPROVAL_PATH),
  ]);
  validatePaidRpcApproval(content, {
    isFile: file.isFile(),
    uid: file.uid,
    gid: file.gid,
    expectedPaidServiceGid: process.getgid(),
    mode: file.mode,
  });
}
