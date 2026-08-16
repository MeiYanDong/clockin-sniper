import { CanonicalInvariantError, type CapitalReservation } from "../core/canonical.js";
import type { PersistedNonceSlot, SqliteStore } from "../persistence/sqlite-store.js";

export type NonceSlotState =
  | "RESERVED"
  | "SIGNED"
  | "POSSIBLY_SUBMITTED"
  | "CONSUMED"
  | "RELEASED"
  | "UNKNOWN";

export interface NonceSlot {
  readonly walletAddress: `0x${string}`;
  readonly nonce: bigint;
  readonly ownerId: string;
  readonly fencingEpoch: number;
  readonly purpose: "ENTRY" | "EXIT" | "RECOVERY" | "TREASURY_SWEEP";
  readonly state: NonceSlotState;
  readonly planId: string;
}

interface MutableSlot {
  walletAddress: `0x${string}`;
  nonce: bigint;
  ownerId: string;
  fencingEpoch: number;
  purpose: NonceSlot["purpose"];
  state: NonceSlotState;
  planId: string;
}

export class WalletTransactionCoordinator {
  readonly #store: SqliteStore;
  readonly #slots = new Map<string, MutableSlot>();
  readonly #epochs = new Map<string, number>();

  constructor(store: SqliteStore) {
    this.#store = store;
  }

  acquire(
    walletAddress: `0x${string}`,
    ownerId: string,
    latestNonce: bigint,
    pendingNonce: bigint,
    now: string,
    expiresAt: string,
  ): number {
    if (latestNonce !== pendingNonce) {
      throw new CanonicalInvariantError(
        "NONCE_CONFLICT",
        `wallet ${walletAddress} has unknown pending nonce ${pendingNonce}`,
      );
    }
    const epoch = this.#store.acquireServiceLease(
      `wallet:${walletAddress.toLowerCase()}`,
      ownerId,
      expiresAt,
      now,
    );
    this.#epochs.set(walletAddress.toLowerCase(), epoch);
    return epoch;
  }

  reserve(
    walletAddress: `0x${string}`,
    ownerId: string,
    fencingEpoch: number,
    nonce: bigint,
    purpose: NonceSlot["purpose"],
    planId: string,
    updatedAt = new Date().toISOString(),
  ): NonceSlot {
    const walletKey = walletAddress.toLowerCase();
    if (this.#epochs.get(walletKey) !== fencingEpoch) {
      throw new CanonicalInvariantError("NONCE_CONFLICT", "stale wallet fencing epoch");
    }
    const key = `${walletKey}:${nonce}`;
    const existing = this.#slots.get(key);
    if (existing !== undefined && existing.state !== "RELEASED") {
      throw new CanonicalInvariantError(
        "NONCE_CONFLICT",
        `wallet nonce ${walletAddress}:${nonce} is already owned by ${existing.ownerId}`,
      );
    }
    const slot: MutableSlot = {
      walletAddress,
      nonce,
      ownerId,
      fencingEpoch,
      purpose,
      state: "RESERVED",
      planId,
    };
    this.#store.reserveWalletNonceSlot(slot, updatedAt);
    this.#slots.set(key, slot);
    return Object.freeze({ ...slot });
  }

  reserveWithCapital(
    reservation: CapitalReservation,
    walletAddress: `0x${string}`,
    ownerId: string,
    fencingEpoch: number,
    nonce: bigint,
    purpose: NonceSlot["purpose"],
    planId: string,
    updatedAt = new Date().toISOString(),
  ): NonceSlot {
    const walletKey = walletAddress.toLowerCase();
    if (this.#epochs.get(walletKey) !== fencingEpoch) {
      throw new CanonicalInvariantError("NONCE_CONFLICT", "stale wallet fencing epoch");
    }
    const slot: MutableSlot = {
      walletAddress,
      nonce,
      ownerId,
      fencingEpoch,
      purpose,
      state: "RESERVED",
      planId,
    };
    this.#store.reserveCapitalAndNonceSlot(reservation, slot, updatedAt);
    this.#slots.set(`${walletKey}:${nonce}`, slot);
    return Object.freeze({ ...slot });
  }

  transition(
    slot: NonceSlot,
    state: NonceSlotState,
    updatedAt = new Date().toISOString(),
  ): NonceSlot {
    const key = `${slot.walletAddress.toLowerCase()}:${slot.nonce}`;
    const current =
      this.#slots.get(key) ??
      this.#fromPersisted(this.#store.walletNonceSlot(slot.walletAddress, slot.nonce));
    if (
      current === undefined ||
      current.ownerId !== slot.ownerId ||
      current.fencingEpoch !== slot.fencingEpoch ||
      current.planId !== slot.planId
    ) {
      throw new CanonicalInvariantError("NONCE_CONFLICT", "nonce slot ownership mismatch");
    }
    if (
      (current.state === "POSSIBLY_SUBMITTED" || current.state === "UNKNOWN") &&
      state === "RELEASED"
    ) {
      throw new CanonicalInvariantError(
        "TRANSPORT_UNKNOWN",
        "possibly submitted nonce cannot be released without canonical proof",
      );
    }
    current.state = state;
    this.#store.updateWalletNonceSlot(current, state, updatedAt);
    this.#slots.set(key, current);
    return Object.freeze({ ...current });
  }

  reconcileCanonicalReceipt(
    slot: NonceSlot,
    evidence: Readonly<{
      receiptStatus: "SUCCESS" | "REVERTED";
      receiptCanonical: boolean;
      latestNonce: bigint;
      pendingNonce: bigint;
    }>,
    updatedAt = new Date().toISOString(),
  ): NonceSlot {
    if (!evidence.receiptCanonical) {
      throw new CanonicalInvariantError(
        "REORG_DETECTED",
        "non-canonical receipt cannot consume a nonce slot",
      );
    }
    const consumedNonce = slot.nonce + 1n;
    if (evidence.latestNonce < consumedNonce || evidence.pendingNonce < consumedNonce) {
      throw new CanonicalInvariantError(
        "NONCE_CONFLICT",
        "receipt exists but latest/pending nonce readback has not consumed the slot",
      );
    }
    return this.transition(slot, "CONSUMED", updatedAt);
  }

  releaseAfterDeterministicRejection(
    slot: NonceSlot,
    evidence: Readonly<{ allRoutesRejected: boolean; signedHashUnchanged: boolean }>,
    updatedAt = new Date().toISOString(),
  ): NonceSlot {
    if (!evidence.allRoutesRejected || !evidence.signedHashUnchanged) {
      throw new CanonicalInvariantError(
        "TRANSPORT_UNKNOWN",
        "nonce release requires deterministic rejection on every route",
      );
    }
    const key = `${slot.walletAddress.toLowerCase()}:${slot.nonce}`;
    const current =
      this.#slots.get(key) ??
      this.#fromPersisted(this.#store.walletNonceSlot(slot.walletAddress, slot.nonce));
    if (
      current === undefined ||
      current.ownerId !== slot.ownerId ||
      current.fencingEpoch !== slot.fencingEpoch ||
      current.planId !== slot.planId ||
      (current.state !== "POSSIBLY_SUBMITTED" && current.state !== "SIGNED")
    ) {
      throw new CanonicalInvariantError("NONCE_CONFLICT", "nonce slot is not releasable by owner");
    }
    current.state = "RELEASED";
    this.#store.updateWalletNonceSlot(current, "RELEASED", updatedAt);
    this.#slots.set(key, current);
    return Object.freeze({ ...current });
  }

  claimEntryIntent(input: {
    strategyId: string;
    launchId: string;
    walletAddress: `0x${string}`;
    intentId: string;
    createdAt: string;
  }): boolean {
    return this.#store.claimWalletEntryIntent(input);
  }

  assertExitAllowed(walletAddress: `0x${string}`): void {
    const blocked =
      this.#store.walletHasUnresolvedNonce(walletAddress) ||
      [...this.#slots.values()].some(
        (slot) =>
          slot.walletAddress.toLowerCase() === walletAddress.toLowerCase() &&
          (slot.state === "POSSIBLY_SUBMITTED" || slot.state === "UNKNOWN"),
      );
    if (blocked) {
      throw new CanonicalInvariantError(
        "NONCE_CONFLICT",
        "wallet entry nonce is unresolved; exit nonce creation is blocked",
      );
    }
  }

  assertTreasurySweepAllowed(input: {
    readonly walletAddress: `0x${string}`;
    readonly entryEnabled: boolean;
    readonly openPositionCount: number;
  }): void {
    if (input.entryEnabled || input.openPositionCount !== 0) {
      throw new CanonicalInvariantError(
        "STATE_TRANSITION_INVALID",
        "treasury sweep requires entry disabled and zero open positions",
      );
    }
    this.assertExitAllowed(input.walletAddress);
  }

  #fromPersisted(slot: PersistedNonceSlot | undefined): MutableSlot | undefined {
    return slot === undefined ? undefined : { ...slot };
  }
}
