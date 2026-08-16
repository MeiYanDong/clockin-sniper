import type { DispatchOutcome, FeeObservation, SubmissionResult, TrancheIntent } from "./domain.js";
import type { FeeTrancheScheduler } from "./tranche-scheduler.js";

/** Resolves when transport returns accepted/known/unknown; it must not wait for a receipt. */
export interface TrancheSubmitter {
  submit(intent: TrancheIntent): Promise<SubmissionResult>;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class ClockInSniperEngine {
  readonly #scheduler: FeeTrancheScheduler;
  readonly #submitter: TrancheSubmitter;

  constructor(scheduler: FeeTrancheScheduler, submitter: TrancheSubmitter) {
    this.#scheduler = scheduler;
    this.#submitter = submitter;
  }

  async observe(observation: FeeObservation): Promise<DispatchOutcome | null> {
    const intent = this.#scheduler.claimNext(observation);
    if (intent === null) {
      return null;
    }

    try {
      const submission = await this.#submitter.submit(intent);
      this.#scheduler.markSubmitted(intent.intentId, submission);
      return Object.freeze({ kind: "submitted", intent, submission });
    } catch (error) {
      const message = errorMessage(error);
      this.#scheduler.markTransportError(intent.intentId, message);
      return Object.freeze({ kind: "transport_error", intent, error: message });
    }
  }
}
