import { stableHash, type IsoTimestamp } from "../core/canonical.js";

export interface EntryExitControlSnapshot {
  readonly entryEnabled: boolean;
  readonly exitEnabled: boolean;
  readonly openPositionCount: number;
  readonly exitServiceRequired: boolean;
  readonly entryStopReason?: string;
}

export interface ManualExitAudit {
  readonly eventId: string;
  readonly eventKind: "MANUAL_EXIT_NOW";
  readonly operatorId: string;
  readonly lotId: string;
  readonly routeQuoteId: string;
  readonly maximumSlippageBps: number;
  readonly observedAt: IsoTimestamp;
}

export interface ShutdownDecision {
  readonly entryEnabled: false;
  readonly exitEnabled: boolean;
  readonly state: "STOPPED" | "DRAINING_POSITIONS";
  readonly residualPositionIds: readonly string[];
  readonly reason: string;
}

export class EntryExitControl {
  #entryEnabled: boolean;
  #exitEnabled: boolean;
  #entryStopReason: string | undefined;

  constructor(entryEnabled = true, exitEnabled = true) {
    this.#entryEnabled = entryEnabled;
    this.#exitEnabled = exitEnabled;
  }

  stopEntry(reason: string): void {
    if (reason.trim().length === 0) throw new RangeError("entry stop reason is required");
    this.#entryEnabled = false;
    this.#entryStopReason = reason;
  }

  setExitEnabled(enabled: boolean): void {
    this.#exitEnabled = enabled;
  }

  snapshot(openPositionCount: number): EntryExitControlSnapshot {
    if (!Number.isSafeInteger(openPositionCount) || openPositionCount < 0) {
      throw new RangeError("openPositionCount must be a non-negative integer");
    }
    return Object.freeze({
      entryEnabled: this.#entryEnabled,
      exitEnabled: this.#exitEnabled,
      openPositionCount,
      exitServiceRequired: openPositionCount > 0,
      ...(this.#entryStopReason === undefined ? {} : { entryStopReason: this.#entryStopReason }),
    });
  }

  assertExitAllowed(): void {
    if (!this.#exitEnabled) throw new Error("exit is explicitly disabled");
  }

  authorizeExitNow(input: {
    operatorId: string;
    lotId: string;
    routeQuoteId: string;
    maximumSlippageBps: number;
    observedAt: IsoTimestamp;
  }): ManualExitAudit {
    this.assertExitAllowed();
    if (
      !Number.isSafeInteger(input.maximumSlippageBps) ||
      input.maximumSlippageBps < 0 ||
      input.maximumSlippageBps >= 10_000
    ) {
      throw new RangeError("manual exit requires an explicit bounded slippage");
    }
    return Object.freeze({
      eventId: `manual-exit:${stableHash(input)}`,
      eventKind: "MANUAL_EXIT_NOW",
      operatorId: input.operatorId,
      lotId: input.lotId,
      routeQuoteId: input.routeQuoteId,
      maximumSlippageBps: input.maximumSlippageBps,
      observedAt: input.observedAt,
    });
  }

  requestGlobalShutdown(openPositionIds: readonly string[], reason: string): ShutdownDecision {
    if (reason.trim().length === 0) throw new RangeError("shutdown reason is required");
    this.stopEntry(reason);
    if (openPositionIds.length > 0) {
      this.#exitEnabled = true;
      return Object.freeze({
        entryEnabled: false,
        exitEnabled: true,
        state: "DRAINING_POSITIONS",
        residualPositionIds: Object.freeze([...openPositionIds]),
        reason,
      });
    }
    this.#exitEnabled = false;
    return Object.freeze({
      entryEnabled: false,
      exitEnabled: false,
      state: "STOPPED",
      residualPositionIds: Object.freeze([]),
      reason,
    });
  }
}
