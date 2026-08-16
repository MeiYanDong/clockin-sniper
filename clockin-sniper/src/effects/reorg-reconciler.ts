import {
  stableHash,
  type EffectRecord,
  type IsoTimestamp,
  type PositionLot,
  type LaunchIdentity,
  type WalletLane,
} from "../core/canonical.js";
import { markIdentityForReorg } from "../identity/identity-binder.js";

export interface ReorgRevision {
  readonly effect: EffectRecord;
  readonly positionLot?: PositionLot;
  readonly auditEvent: Readonly<{
    eventId: string;
    eventKind: "EFFECT_REORGED";
    parentEffectId: string;
    oldBlockHash: string;
    observedAt: IsoTimestamp;
  }>;
}

function knownBlockHash(effect: EffectRecord): string | undefined {
  return effect.blockHash.state === "KNOWN" ? effect.blockHash.value : undefined;
}

export function reconcileEffectCanonicality(
  effect: EffectRecord,
  lot: PositionLot | undefined,
  canonicalReceiptBlockHash: string | null,
  observedAt: IsoTimestamp,
): ReorgRevision | null {
  const oldBlockHash = knownBlockHash(effect);
  if (
    oldBlockHash !== undefined &&
    canonicalReceiptBlockHash !== null &&
    oldBlockHash.toLowerCase() === canonicalReceiptBlockHash.toLowerCase()
  ) {
    return null;
  }
  if (effect.canonicality === "REORGED") return null;

  const auditEvent = Object.freeze({
    eventId: `audit:reorg:${stableHash({ effectId: effect.effectId, revision: effect.revision + 1 })}`,
    eventKind: "EFFECT_REORGED" as const,
    parentEffectId: effect.effectId,
    oldBlockHash: oldBlockHash ?? "UNKNOWN",
    observedAt,
  });
  const revisedEffect: EffectRecord = Object.freeze({
    ...effect,
    revision: effect.revision + 1,
    canonicality: "REORGED",
    result: "DISPUTED",
    settlement: "UNKNOWN",
    positionLotIds: Object.freeze([]),
    evidenceIds: Object.freeze([...effect.evidenceIds, auditEvent.eventId]),
    observedAt,
  });
  const revisedLot: PositionLot | undefined =
    lot === undefined
      ? undefined
      : Object.freeze({
          ...lot,
          revision: lot.revision + 1,
          state: "UNKNOWN",
          evidenceIds: Object.freeze([...lot.evidenceIds, auditEvent.eventId]),
          updatedAt: observedAt,
        });
  return Object.freeze({
    effect: revisedEffect,
    ...(revisedLot === undefined ? {} : { positionLot: revisedLot }),
    auditEvent,
  });
}

export interface FullReorgReconciliation {
  readonly identity: LaunchIdentity;
  readonly effectRevision: ReorgRevision | null;
  readonly walletReadback: Readonly<{
    walletAddress: `0x${string}`;
    latestNonce: bigint;
    pendingNonce: bigint;
    tokenBalanceRaw: bigint;
    principalBalanceRaw: bigint;
    evidenceIds: readonly string[];
  }>;
  readonly unsentLaneStates: readonly Readonly<{
    laneId: string;
    state: WalletLane["state"];
    reason: string;
  }>[];
}

export function reconcileLaunchAndWalletAfterReorg(input: {
  readonly identity: LaunchIdentity;
  readonly effect: EffectRecord;
  readonly lot?: PositionLot;
  readonly canonicalReceiptBlockHash: string | null;
  readonly walletAddress: `0x${string}`;
  readonly latestNonce: bigint;
  readonly pendingNonce: bigint;
  readonly tokenBalanceRaw: bigint;
  readonly principalBalanceRaw: bigint;
  readonly unsentLanes: readonly WalletLane[];
  readonly newValiditySatisfied: boolean;
  readonly evidenceIds: readonly string[];
  readonly observedAt: IsoTimestamp;
}): FullReorgReconciliation {
  for (const value of [
    input.latestNonce,
    input.pendingNonce,
    input.tokenBalanceRaw,
    input.principalBalanceRaw,
  ]) {
    if (value < 0n) throw new RangeError("reorg wallet readback cannot be negative");
  }
  return Object.freeze({
    identity: markIdentityForReorg(input.identity),
    effectRevision: reconcileEffectCanonicality(
      input.effect,
      input.lot,
      input.canonicalReceiptBlockHash,
      input.observedAt,
    ),
    walletReadback: Object.freeze({
      walletAddress: input.walletAddress,
      latestNonce: input.latestNonce,
      pendingNonce: input.pendingNonce,
      tokenBalanceRaw: input.tokenBalanceRaw,
      principalBalanceRaw: input.principalBalanceRaw,
      evidenceIds: Object.freeze([...input.evidenceIds]),
    }),
    unsentLaneStates: Object.freeze(
      input.unsentLanes.map((lane) =>
        Object.freeze({
          laneId: lane.laneId,
          state: input.newValiditySatisfied ? lane.state : ("EXPIRED" as const),
          reason: input.newValiditySatisfied
            ? "new canonical validity permits the unsent lane to remain pending"
            : "reorg invalidated the unsent lane validity envelope",
        }),
      ),
    ),
  });
}
