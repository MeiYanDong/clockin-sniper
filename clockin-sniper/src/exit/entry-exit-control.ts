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
  readonly eventKind: "MANUAL_EXIT_NOW" | "BREAK_GLASS_EXIT";
  readonly operatorId: string;
  readonly lotId: string;
  readonly routeQuoteId: string;
  readonly maximumSlippageBps: number;
  readonly observedAt: IsoTimestamp;
  readonly secondConfirmationId?: string;
  readonly justification?: string;
}

export interface ExitSlippagePolicy {
  readonly routineMaximumSlippageBps: number;
  readonly breakGlassMaximumSlippageBps: number;
}

export const PRODUCTION_EXIT_SLIPPAGE_POLICY: ExitSlippagePolicy = Object.freeze({
  routineMaximumSlippageBps: 500,
  breakGlassMaximumSlippageBps: 2_000,
});

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
  readonly #slippagePolicy: ExitSlippagePolicy;

  constructor(
    entryEnabled = true,
    exitEnabled = true,
    slippagePolicy: ExitSlippagePolicy = PRODUCTION_EXIT_SLIPPAGE_POLICY,
  ) {
    if (
      !Number.isSafeInteger(slippagePolicy.routineMaximumSlippageBps) ||
      !Number.isSafeInteger(slippagePolicy.breakGlassMaximumSlippageBps) ||
      slippagePolicy.routineMaximumSlippageBps < 0 ||
      slippagePolicy.breakGlassMaximumSlippageBps >= 10_000 ||
      slippagePolicy.routineMaximumSlippageBps >= slippagePolicy.breakGlassMaximumSlippageBps
    ) {
      throw new RangeError("exit slippage policy must keep routine below bounded break-glass");
    }
    this.#entryEnabled = entryEnabled;
    this.#exitEnabled = exitEnabled;
    this.#slippagePolicy = Object.freeze({ ...slippagePolicy });
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
      input.maximumSlippageBps > this.#slippagePolicy.routineMaximumSlippageBps
    ) {
      throw new RangeError("routine exit exceeds its maximum slippage");
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

  authorizeBreakGlassExit(input: {
    operatorId: string;
    lotId: string;
    routeQuoteId: string;
    maximumSlippageBps: number;
    secondConfirmationId: string;
    justification: string;
    observedAt: IsoTimestamp;
  }): ManualExitAudit {
    this.assertExitAllowed();
    if (
      !Number.isSafeInteger(input.maximumSlippageBps) ||
      input.maximumSlippageBps < 0 ||
      input.maximumSlippageBps > this.#slippagePolicy.breakGlassMaximumSlippageBps
    ) {
      throw new RangeError("break-glass exit exceeds its maximum slippage");
    }
    if (input.secondConfirmationId.trim().length === 0) {
      throw new RangeError("break-glass exit requires a second confirmation ID");
    }
    if (input.justification.trim().length === 0) {
      throw new RangeError("break-glass exit requires an operator justification");
    }
    return Object.freeze({
      eventId: `break-glass-exit:${stableHash(input)}`,
      eventKind: "BREAK_GLASS_EXIT",
      operatorId: input.operatorId,
      lotId: input.lotId,
      routeQuoteId: input.routeQuoteId,
      maximumSlippageBps: input.maximumSlippageBps,
      secondConfirmationId: input.secondConfirmationId,
      justification: input.justification,
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
