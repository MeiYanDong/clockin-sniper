import { stableHash } from "../core/canonical.js";

export interface DownsidePolicyConfig {
  readonly initialStopLossBps: number;
  readonly stopLossConfirmationBlocks: number;
  readonly prePrincipalMaximumHoldingMs: number;
  readonly noLiquidityPolicy: "ALERT_AND_RETRY_VERIFIED_ROUTES";
}

export interface DownsidePolicyState {
  readonly positionOpenedAtMs: number;
  readonly postEntryExecutableNetBaselineRaw: bigint;
  readonly lastCanonicalBlockNumber: bigint | null;
  readonly consecutiveBelowStopBlocks: number;
}

export interface DownsidePolicyDecision {
  readonly decisionId: string;
  readonly action: "HOLD" | "EXIT_ALL" | "ALERT_AND_RETRY_VERIFIED_ROUTES" | "NOT_APPLICABLE";
  readonly reason: string;
  readonly stopThresholdRaw: bigint;
  readonly updatedState: DownsidePolicyState;
}

function validate(input: {
  actualRecoveredProceedsRaw: bigint;
  actualCostRaw: bigint;
  executableNetLiquidationRaw: bigint | null;
  executableRouteCount: number;
  canonicalBlockNumber: bigint;
  nowMs: number;
  state: DownsidePolicyState;
  config: DownsidePolicyConfig;
}): void {
  if (input.actualRecoveredProceedsRaw < 0n || input.actualCostRaw <= 0n) {
    throw new RangeError(
      "recovered proceeds must be non-negative and actual cost must be positive",
    );
  }
  if (input.executableNetLiquidationRaw !== null && input.executableNetLiquidationRaw < 0n) {
    throw new RangeError("executable net liquidation value cannot be negative");
  }
  if (!Number.isSafeInteger(input.executableRouteCount) || input.executableRouteCount < 0) {
    throw new RangeError("executable route count must be a non-negative safe integer");
  }
  if (input.canonicalBlockNumber < 0n) throw new RangeError("canonical block cannot be negative");
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < input.state.positionOpenedAtMs) {
    throw new RangeError("nowMs must be a safe timestamp no earlier than position open");
  }
  if (
    !Number.isSafeInteger(input.state.positionOpenedAtMs) ||
    input.state.positionOpenedAtMs < 0 ||
    input.state.postEntryExecutableNetBaselineRaw <= 0n ||
    !Number.isSafeInteger(input.state.consecutiveBelowStopBlocks) ||
    input.state.consecutiveBelowStopBlocks < 0
  ) {
    throw new RangeError("downside state is invalid");
  }
  if (
    !Number.isSafeInteger(input.config.initialStopLossBps) ||
    input.config.initialStopLossBps < 0 ||
    input.config.initialStopLossBps >= 10_000
  ) {
    throw new RangeError("initial stop loss must be between 0 and 9999 bps");
  }
  if (
    !Number.isSafeInteger(input.config.stopLossConfirmationBlocks) ||
    input.config.stopLossConfirmationBlocks <= 0
  ) {
    throw new RangeError("stop-loss confirmation blocks must be positive");
  }
  if (
    !Number.isSafeInteger(input.config.prePrincipalMaximumHoldingMs) ||
    input.config.prePrincipalMaximumHoldingMs <= 0
  ) {
    throw new RangeError("pre-principal maximum holding time must be positive");
  }
  if (input.config.noLiquidityPolicy !== "ALERT_AND_RETRY_VERIFIED_ROUTES") {
    throw new Error("unsupported no-liquidity policy");
  }
}

export function decidePrePrincipalDownside(input: {
  readonly actualRecoveredProceedsRaw: bigint;
  readonly actualCostRaw: bigint;
  readonly executableNetLiquidationRaw: bigint | null;
  readonly executableRouteCount: number;
  readonly feeWindowClosed: boolean;
  readonly canonicalBlockNumber: bigint;
  readonly nowMs: number;
  readonly state: DownsidePolicyState;
  readonly config: DownsidePolicyConfig;
}): DownsidePolicyDecision {
  validate(input);
  if (
    input.state.lastCanonicalBlockNumber !== null &&
    input.canonicalBlockNumber < input.state.lastCanonicalBlockNumber
  ) {
    throw new Error("downside decision received an out-of-order canonical block");
  }
  const stopThresholdRaw =
    (input.state.postEntryExecutableNetBaselineRaw *
      BigInt(10_000 - input.config.initialStopLossBps)) /
    10_000n;
  let action: DownsidePolicyDecision["action"] = "HOLD";
  let reason = "pre-principal downside threshold not reached";
  let updatedState = input.state;

  if (input.actualRecoveredProceedsRaw >= input.actualCostRaw) {
    action = "NOT_APPLICABLE";
    reason = "principal has already been recovered; runner policy owns the position";
  } else if (
    input.executableRouteCount === 0 ||
    input.executableNetLiquidationRaw === null ||
    input.executableNetLiquidationRaw === 0n
  ) {
    action = "ALERT_AND_RETRY_VERIFIED_ROUTES";
    reason = "no economically executable verified route; do not widen slippage automatically";
  } else if (!input.feeWindowClosed) {
    reason = "initial fee window remains active; post-entry stop-loss sampling has not started";
  } else if (
    input.nowMs - input.state.positionOpenedAtMs >=
    input.config.prePrincipalMaximumHoldingMs
  ) {
    action = "EXIT_ALL";
    reason = "pre-principal maximum holding time elapsed with an executable route";
  } else {
    const sameBlock = input.state.lastCanonicalBlockNumber === input.canonicalBlockNumber;
    if (!sameBlock) {
      const belowStop = input.executableNetLiquidationRaw <= stopThresholdRaw;
      const adjacent =
        input.state.lastCanonicalBlockNumber !== null &&
        input.canonicalBlockNumber === input.state.lastCanonicalBlockNumber + 1n;
      const consecutiveBelowStopBlocks = belowStop
        ? adjacent
          ? input.state.consecutiveBelowStopBlocks + 1
          : 1
        : 0;
      updatedState = Object.freeze({
        ...input.state,
        lastCanonicalBlockNumber: input.canonicalBlockNumber,
        consecutiveBelowStopBlocks,
      });
      if (consecutiveBelowStopBlocks >= input.config.stopLossConfirmationBlocks) {
        action = "EXIT_ALL";
        reason = "executable net value confirmed below the initial stop on consecutive blocks";
      } else if (belowStop) {
        reason = "first below-stop canonical block observed; awaiting confirmation";
      }
    } else {
      reason = "same canonical block already sampled; confirmation counter unchanged";
    }
  }

  return Object.freeze({
    decisionId: `downside-decision:${stableHash({
      action,
      reason,
      actualRecoveredProceedsRaw: input.actualRecoveredProceedsRaw.toString(),
      actualCostRaw: input.actualCostRaw.toString(),
      executableNetLiquidationRaw: input.executableNetLiquidationRaw?.toString() ?? null,
      canonicalBlockNumber: input.canonicalBlockNumber.toString(),
      consecutiveBelowStopBlocks: updatedState.consecutiveBelowStopBlocks,
    })}`,
    action,
    reason,
    stopThresholdRaw,
    updatedState,
  });
}
