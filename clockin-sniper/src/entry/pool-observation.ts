import { CanonicalInvariantError, stableHash } from "../core/canonical.js";
import type { CapScope, CooldownScope } from "../identity/mechanism-profiler.js";

export interface ExactBlockRef {
  readonly blockNumber: bigint;
  readonly blockHash: `0x${string}`;
  readonly blockTimestamp: bigint;
}

export interface PoolObservation {
  readonly observationId: string;
  readonly profileRevision: number;
  readonly block: ExactBlockRef;
  readonly currentFeeBps: number;
  readonly inWindow: boolean;
  readonly capRaw: bigint;
  readonly capScope: CapScope;
  readonly cooldownSeconds: number;
  readonly cooldownScope: CooldownScope;
  readonly eoaOnlyActive: boolean;
  readonly quoteAsset: `0x${string}`;
  readonly curveStateHash: string;
  readonly evidenceIds: readonly string[];
}

export interface PoolReadAdapter {
  readonly adapterId: string;
  readBlock(blockNumber: bigint): Promise<ExactBlockRef>;
  readFeeBps(blockNumber: bigint): Promise<number>;
  readWindow(blockNumber: bigint): Promise<boolean>;
  readCap(blockNumber: bigint): Promise<{ value: bigint; scope: CapScope }>;
  readCooldown(blockNumber: bigint): Promise<{ seconds: number; scope: CooldownScope }>;
  readEoaOnly(blockNumber: bigint): Promise<boolean>;
  readQuoteAsset(blockNumber: bigint): Promise<`0x${string}`>;
  readCurveStateHash(blockNumber: bigint): Promise<string>;
}

export async function observePoolAt(
  adapter: PoolReadAdapter,
  profileRevision: number,
  blockNumber: bigint,
  evidenceIds: readonly string[],
): Promise<PoolObservation> {
  const [block, fee, window, cap, cooldown, eoaOnly, quoteAsset, curveStateHash] =
    await Promise.all([
      adapter.readBlock(blockNumber),
      adapter.readFeeBps(blockNumber),
      adapter.readWindow(blockNumber),
      adapter.readCap(blockNumber),
      adapter.readCooldown(blockNumber),
      adapter.readEoaOnly(blockNumber),
      adapter.readQuoteAsset(blockNumber),
      adapter.readCurveStateHash(blockNumber),
    ]);
  if (block.blockNumber !== blockNumber) {
    throw new CanonicalInvariantError(
      "STATE_TRANSITION_INVALID",
      `adapter returned block ${block.blockNumber} for requested block ${blockNumber}`,
    );
  }
  if (!Number.isSafeInteger(fee) || fee < 0 || fee > 10_000) {
    throw new CanonicalInvariantError("POOL_STATE_INVALID", "pool fee is outside 0..10000 bps");
  }
  if (cap.value < 0n) {
    throw new CanonicalInvariantError("POOL_STATE_INVALID", "pool cap cannot be negative");
  }
  if (!Number.isSafeInteger(cooldown.seconds) || cooldown.seconds < 0) {
    throw new CanonicalInvariantError("POOL_STATE_INVALID", "pool cooldown is invalid");
  }
  if (
    curveStateHash.trim().length === 0 ||
    quoteAsset === "0x0000000000000000000000000000000000000000"
  ) {
    throw new CanonicalInvariantError(
      "POOL_STATE_INVALID",
      "pool quote/curve state is impossible for an executable observation",
    );
  }
  const base = {
    adapterId: adapter.adapterId,
    profileRevision,
    blockNumber: block.blockNumber.toString(),
    blockHash: block.blockHash,
    fee,
    window,
    cap: cap.value.toString(),
    capScope: cap.scope,
    cooldown,
    eoaOnly,
    quoteAsset,
    curveStateHash,
  };
  return Object.freeze({
    observationId: `pool-observation:${stableHash(base)}`,
    profileRevision,
    block,
    currentFeeBps: fee,
    inWindow: window,
    capRaw: cap.value,
    capScope: cap.scope,
    cooldownSeconds: cooldown.seconds,
    cooldownScope: cooldown.scope,
    eoaOnlyActive: eoaOnly,
    quoteAsset,
    curveStateHash,
    evidenceIds: Object.freeze([...evidenceIds]),
  });
}

export function assertProviderBlockAgreement(blocks: readonly ExactBlockRef[]): ExactBlockRef {
  if (blocks.length === 0) throw new RangeError("at least one provider block is required");
  const first = blocks[0] as ExactBlockRef;
  if (
    blocks.some(
      (block) =>
        block.blockNumber !== first.blockNumber ||
        block.blockHash.toLowerCase() !== first.blockHash.toLowerCase(),
    )
  ) {
    throw new Error("provider split brain: canonical block references disagree");
  }
  return first;
}
