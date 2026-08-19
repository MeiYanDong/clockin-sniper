import { readFile, stat } from "node:fs/promises";

export const PRODUCTION_ARM_APPROVAL_PATH = "/etc/clockin-sniper/PRODUCTION_ARM_APPROVED";
export const PRODUCTION_ARM_APPROVAL_VALUE = "CLOCKIN_PRODUCTION_ARM_APPROVED_V1";

export interface ProductionArmApprovalMetadata {
  readonly isFile: boolean;
  readonly uid: number;
  readonly gid: number;
  readonly expectedPaidServiceGid: number;
  readonly mode: number;
}

export function validateProductionArmApproval(
  content: string,
  metadata: ProductionArmApprovalMetadata,
): void {
  if (!metadata.isFile) throw new Error("production arm marker is not a regular file");
  if (metadata.uid !== 0) throw new Error("production arm marker must be owned by root");
  if (metadata.gid !== metadata.expectedPaidServiceGid) {
    throw new Error("production arm marker must be grouped to the paid service");
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error("production arm marker must not be group/world writable");
  }
  if ((metadata.mode & 0o777) !== 0o440) {
    throw new Error("production arm marker must have exact mode 0440");
  }
  if (content.trim() !== PRODUCTION_ARM_APPROVAL_VALUE) {
    throw new Error("production arm marker has an invalid value");
  }
}

/** This funds-authorization check runs before any signer credential is read. */
export async function assertProductionArmApproved(): Promise<void> {
  if (process.getgid === undefined) {
    throw new Error("production arm approval requires a POSIX paid-service group");
  }
  const [content, file] = await Promise.all([
    readFile(PRODUCTION_ARM_APPROVAL_PATH, "utf8"),
    stat(PRODUCTION_ARM_APPROVAL_PATH),
  ]);
  validateProductionArmApproval(content, {
    isFile: file.isFile(),
    uid: file.uid,
    gid: file.gid,
    expectedPaidServiceGid: process.getgid(),
    mode: file.mode,
  });
}
