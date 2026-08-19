import { getBytes, keccak256 } from "ethers";
import type { Address, Hex32, TxAttempt } from "../core/canonical.js";

export interface RecoveryReceipt {
  readonly txHash: Hex32;
  readonly blockHash: Hex32;
  readonly status: 0 | 1;
}

export interface RecoveryProbeSnapshot {
  readonly receipt: RecoveryReceipt | null;
  readonly transactionKnown: boolean;
  readonly latestNonce: bigint;
  readonly pendingNonce: bigint;
  readonly principalBalanceRaw: bigint;
  readonly tokenBalanceRaw: bigint;
}

export interface UnknownRecoveryProbe {
  snapshot(walletAddress: Address, txHash: Hex32): Promise<RecoveryProbeSnapshot>;
}

export interface RecoveryVault {
  get(reference: string, expectedTxHash: `0x${string}`): Promise<`0x${string}`>;
}

export interface RecoveryBroadcaster {
  broadcast(rawTransaction: `0x${string}`): Promise<{ readonly txHash: `0x${string}` }>;
}

export interface UnknownRecoveryResult {
  readonly attemptId: string;
  readonly txHash: Hex32;
  readonly state:
    | "RECEIPT_FOUND"
    | "PENDING"
    | "REBROADCASTED"
    | "NONCE_MISMATCH_UNRESOLVED"
    | "EXPIRED_UNRESOLVED";
  readonly nonceLeaseMustRemain: true;
  readonly reservationMustRemain: true;
  readonly backgroundRecheckRequired: boolean;
  readonly probe: RecoveryProbeSnapshot;
}

export class UnknownRecoveryManager {
  readonly #probe: UnknownRecoveryProbe;
  readonly #vault: RecoveryVault;
  readonly #broadcaster: RecoveryBroadcaster;
  readonly #beforeBroadcast: () => Promise<void>;

  constructor(options: {
    probe: UnknownRecoveryProbe;
    vault: RecoveryVault;
    broadcaster: RecoveryBroadcaster;
    beforeBroadcast?: () => Promise<void>;
  }) {
    this.#probe = options.probe;
    this.#vault = options.vault;
    this.#broadcaster = options.broadcaster;
    this.#beforeBroadcast = options.beforeBroadcast ?? (async () => undefined);
  }

  async recover(
    attempt: TxAttempt,
    expiresAtMs: number,
    nowMs: number,
  ): Promise<UnknownRecoveryResult> {
    if (attempt.state !== "UNKNOWN")
      throw new Error("only UNKNOWN attempts enter same-raw recovery");
    if (attempt.vaultRef === undefined)
      throw new Error("UNKNOWN attempt has no signed transaction vault reference");
    const probe = await this.#probe.snapshot(attempt.walletAddress, attempt.signedTxHash);
    if (probe.receipt !== null) {
      if (probe.receipt.txHash.toLowerCase() !== attempt.signedTxHash.toLowerCase()) {
        throw new Error("recovery receipt hash does not match the attempt");
      }
      return Object.freeze({
        attemptId: attempt.attemptId,
        txHash: attempt.signedTxHash,
        state: "RECEIPT_FOUND",
        nonceLeaseMustRemain: true,
        reservationMustRemain: true,
        backgroundRecheckRequired: false,
        probe,
      });
    }
    if (probe.transactionKnown) {
      return Object.freeze({
        attemptId: attempt.attemptId,
        txHash: attempt.signedTxHash,
        state: "PENDING",
        nonceLeaseMustRemain: true,
        reservationMustRemain: true,
        backgroundRecheckRequired: true,
        probe,
      });
    }
    const attemptNonce = BigInt(attempt.nonce);
    if (probe.latestNonce !== attemptNonce || probe.pendingNonce !== attemptNonce) {
      return Object.freeze({
        attemptId: attempt.attemptId,
        txHash: attempt.signedTxHash,
        state: "NONCE_MISMATCH_UNRESOLVED",
        nonceLeaseMustRemain: true,
        reservationMustRemain: true,
        backgroundRecheckRequired: true,
        probe,
      });
    }
    if (nowMs > expiresAtMs) {
      return Object.freeze({
        attemptId: attempt.attemptId,
        txHash: attempt.signedTxHash,
        state: "EXPIRED_UNRESOLVED",
        nonceLeaseMustRemain: true,
        reservationMustRemain: true,
        backgroundRecheckRequired: true,
        probe,
      });
    }

    const raw = await this.#vault.get(attempt.vaultRef, attempt.signedTxHash);
    const actualHash = keccak256(getBytes(raw));
    if (actualHash.toLowerCase() !== attempt.signedTxHash.toLowerCase()) {
      throw new Error("vault returned a different signed payload");
    }
    await this.#beforeBroadcast();
    const replay = await this.#broadcaster.broadcast(raw);
    if (replay.txHash.toLowerCase() !== attempt.signedTxHash.toLowerCase()) {
      throw new Error("same-raw recovery broadcaster returned a different txHash");
    }
    return Object.freeze({
      attemptId: attempt.attemptId,
      txHash: attempt.signedTxHash,
      state: "REBROADCASTED",
      nonceLeaseMustRemain: true,
      reservationMustRemain: true,
      backgroundRecheckRequired: true,
      probe,
    });
  }
}
