import type { SubmissionResult, TrancheIntent } from "./domain.js";
import type { TrancheSubmitter } from "./engine.js";
import type { LiveLedger } from "./live-ledger.js";
import type { LivePreparedTransactionSource } from "./live-transaction-source.js";
import { MultiRpcRawTransactionSubmitter } from "./raw-fanout-submitter.js";
import type { ReceiptOutcome, ReceiptReconciler } from "./receipt-reconciler.js";
import type { JsonRpcRequester } from "./rpc/types.js";

export class LiveTrancheSubmitter implements TrancheSubmitter {
  readonly #source: LivePreparedTransactionSource;
  readonly #fanout: MultiRpcRawTransactionSubmitter;
  readonly #ledger: LiveLedger;
  readonly #reconciler: ReceiptReconciler;
  readonly #reconciliations: Promise<ReceiptOutcome>[] = [];
  readonly #rebroadcasts: Promise<void>[] = [];
  readonly #scheduledTxHashes = new Set<string>();
  readonly #reconciledStates = new Map<number, ReceiptOutcome["state"]>();
  readonly #reconciledAtMs = new Map<number, number>();
  readonly #rebroadcastIntervalMs: number;
  readonly #buyCooldownMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: {
    readonly source: LivePreparedTransactionSource;
    readonly broadcastRequesters: readonly JsonRpcRequester[];
    readonly ledger: LiveLedger;
    readonly reconciler: ReceiptReconciler;
    readonly rebroadcastIntervalMs?: number;
    readonly buyCooldownMs?: number;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  }) {
    if (
      !Number.isSafeInteger(options.rebroadcastIntervalMs ?? 250) ||
      (options.rebroadcastIntervalMs ?? 250) <= 0
    ) {
      throw new RangeError("rebroadcastIntervalMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.buyCooldownMs ?? 0) || (options.buyCooldownMs ?? 0) < 0) {
      throw new RangeError("buyCooldownMs must be a non-negative safe integer");
    }
    this.#source = options.source;
    this.#fanout = new MultiRpcRawTransactionSubmitter(options.broadcastRequesters, options.source);
    this.#ledger = options.ledger;
    this.#reconciler = options.reconciler;
    this.#rebroadcastIntervalMs = options.rebroadcastIntervalMs ?? 250;
    this.#buyCooldownMs = options.buyCooldownMs ?? 0;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async submit(intent: TrancheIntent): Promise<SubmissionResult> {
    if (intent.trancheNumber > 1) {
      const previousState = this.#reconciledStates.get(intent.trancheNumber - 1);
      if (previousState !== "success") {
        await this.#ledger.append({
          event: "tranche_gate_blocked",
          launchId: intent.launchId,
          intentId: intent.intentId,
          tranche: intent.trancheNumber,
          previousTranche: intent.trancheNumber - 1,
          previousState: previousState ?? "pending_or_unknown",
        });
        throw new Error("previous tranche has not reconciled as a successful token delivery");
      }
      const previousReconciledAtMs = this.#reconciledAtMs.get(intent.trancheNumber - 1);
      if (previousReconciledAtMs === undefined) {
        throw new Error("previous tranche success is missing its reconciliation time");
      }
      const nextEligibleAtMs = previousReconciledAtMs + this.#buyCooldownMs;
      if (this.#now() < nextEligibleAtMs) {
        await this.#ledger.append({
          event: "tranche_cooldown_blocked",
          launchId: intent.launchId,
          intentId: intent.intentId,
          tranche: intent.trancheNumber,
          previousTranche: intent.trancheNumber - 1,
          previousReconciledAtMs,
          nextEligibleAtMs,
        });
        throw new Error("previous tranche cooldown has not elapsed after reconciliation");
      }
    }
    const metadata = this.#source.metadata(intent.intentId);
    await this.#ledger.append({
      event: "broadcast_attempted",
      launchId: intent.launchId,
      intentId: intent.intentId,
      tranche: intent.trancheNumber,
      attempt: intent.attemptNumber,
      nonce: metadata.nonce,
      txHash: metadata.txHash,
      observedBlock: intent.blockNumber.toString(),
      observedFeeBps: intent.observedFeeBps,
      targetFeeBps: intent.targetFeeBps,
      valueWei: metadata.valueWei.toString(),
    });

    try {
      const result = await this.#fanout.submit(intent);
      await this.#ledger.append({
        event: "broadcast_result",
        launchId: intent.launchId,
        intentId: intent.intentId,
        tranche: intent.trancheNumber,
        nonce: metadata.nonce,
        txHash: metadata.txHash,
        transportState: result.state,
      });
      if (!this.#scheduledTxHashes.has(metadata.txHash)) {
        this.#scheduledTxHashes.add(metadata.txHash);
        const reconciliation = this.#reconciler.reconcile(metadata).then((outcome) => {
          this.#reconciledStates.set(metadata.trancheNumber, outcome.state);
          if (outcome.state === "success") {
            this.#reconciledAtMs.set(metadata.trancheNumber, this.#now());
          }
          return outcome;
        });
        void reconciliation.catch(() => undefined);
        this.#reconciliations.push(reconciliation);
        if (result.state === "unknown") {
          let reconciliationFinished = false;
          void reconciliation.then(
            () => {
              reconciliationFinished = true;
            },
            () => {
              reconciliationFinished = true;
            },
          );
          const rebroadcast = this.#rebroadcastUnknown(
            intent,
            metadata.txHash,
            () => reconciliationFinished,
          );
          void rebroadcast.catch(() => undefined);
          this.#rebroadcasts.push(rebroadcast);
        }
      }
      return result;
    } catch (error) {
      await this.#ledger.append({
        event: "broadcast_rejected",
        launchId: intent.launchId,
        intentId: intent.intentId,
        tranche: intent.trancheNumber,
        nonce: metadata.nonce,
        txHash: metadata.txHash,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async waitForReconciliation(): Promise<readonly ReceiptOutcome[]> {
    await Promise.all(this.#rebroadcasts);
    return Promise.all(this.#reconciliations);
  }

  async #rebroadcastUnknown(
    intent: TrancheIntent,
    txHash: string,
    reconciliationFinished: () => boolean,
  ): Promise<void> {
    let attempt = 0;
    while (!reconciliationFinished() && this.#now() <= intent.expiresAtMs) {
      await this.#sleep(this.#rebroadcastIntervalMs);
      if (reconciliationFinished() || this.#now() > intent.expiresAtMs) return;
      attempt += 1;
      try {
        const result = await this.#fanout.submit({
          ...intent,
          attemptNumber: intent.attemptNumber + attempt,
        });
        await this.#ledger.append({
          event: "exact_raw_rebroadcast",
          launchId: intent.launchId,
          intentId: intent.intentId,
          tranche: intent.trancheNumber,
          txHash,
          attempt,
          transportState: result.state,
        });
        if (result.state !== "unknown") return;
      } catch (error) {
        await this.#ledger.append({
          event: "exact_raw_rebroadcast_rejected",
          launchId: intent.launchId,
          intentId: intent.intentId,
          tranche: intent.trancheNumber,
          txHash,
          attempt,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  }
}
