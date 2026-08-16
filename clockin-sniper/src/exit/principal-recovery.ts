import {
  stableHash,
  type AggregatePosition,
  type PositionLot,
  type RouteQuote,
} from "../core/canonical.js";

export interface ExitPolicyConfig {
  readonly recoverPrincipalMultipleBps: number;
  readonly secondProfitMultipleBps: number;
  readonly secondProfitTokenShareBps: number;
  readonly runnerDrawdownBps: number;
  readonly runnerMaximumHoldingMs: number;
  readonly momentumFailurePolicyId: "DISABLED_UNTIL_REPLAY_V1";
}

export interface RunnerState {
  readonly executableNetPeakRaw: bigint;
  readonly positionOpenedAtMs: number;
  readonly momentumFailed: boolean;
}

export interface LotExitInstruction {
  readonly lotId: string;
  readonly walletAddress: string;
  readonly routeQuoteId: string;
  readonly tokenInputRaw: bigint;
  readonly expectedNetOutputRaw: bigint;
}

export interface ExitPolicyDecision {
  readonly decisionId: string;
  readonly stage: "HOLD" | "RECOVER_PRINCIPAL" | "TAKE_SECOND_PROFIT" | "RUNNER" | "DUST_CLOSE";
  readonly trigger: string;
  readonly instructions: readonly LotExitInstruction[];
  readonly updatedRunnerPeakRaw: bigint;
}

function validateBps(name: string, value: number, maximum = 100_000): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} is outside its supported bps range`);
  }
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  return (numerator + denominator - 1n) / denominator;
}

function allocateByNetTarget(
  lots: readonly PositionLot[],
  quotesByLotId: ReadonlyMap<string, RouteQuote>,
  targetNetRaw: bigint,
): readonly LotExitInstruction[] {
  let remainingTarget = targetNetRaw;
  const instructions: LotExitInstruction[] = [];
  const ordered = [...lots]
    .filter((lot) => BigInt(lot.remainingRaw) > 0n && lot.state !== "UNKNOWN")
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.lotId.localeCompare(right.lotId),
    );
  for (const lot of ordered) {
    if (remainingTarget <= 0n) break;
    const quote = quotesByLotId.get(lot.lotId);
    if (quote === undefined) continue;
    const quoteInput = BigInt(quote.tokenInputRaw);
    const quoteNet = BigInt(quote.netOutputRaw);
    if (quoteInput <= 0n || quoteNet <= 0n) continue;
    const availableInput =
      BigInt(lot.remainingRaw) < quoteInput ? BigInt(lot.remainingRaw) : quoteInput;
    const availableNet = (quoteNet * availableInput) / quoteInput;
    const tokenInputRaw =
      remainingTarget >= availableNet
        ? availableInput
        : ceilDivide(remainingTarget * quoteInput, quoteNet);
    const expectedNetOutputRaw = (quoteNet * tokenInputRaw) / quoteInput;
    instructions.push(
      Object.freeze({
        lotId: lot.lotId,
        walletAddress: lot.walletAddress,
        routeQuoteId: quote.quoteId,
        tokenInputRaw,
        expectedNetOutputRaw,
      }),
    );
    remainingTarget -= expectedNetOutputRaw;
  }
  return Object.freeze(instructions);
}

function allocateByTokenTarget(
  lots: readonly PositionLot[],
  quotesByLotId: ReadonlyMap<string, RouteQuote>,
  targetTokenRaw: bigint,
): readonly LotExitInstruction[] {
  let remaining = targetTokenRaw;
  const instructions: LotExitInstruction[] = [];
  const ordered = [...lots].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.lotId.localeCompare(right.lotId),
  );
  for (const lot of ordered) {
    if (remaining <= 0n) break;
    const quote = quotesByLotId.get(lot.lotId);
    if (quote === undefined || BigInt(quote.netOutputRaw) <= 0n) continue;
    const available = BigInt(lot.remainingRaw);
    const tokenInputRaw = remaining < available ? remaining : available;
    const expectedNetOutputRaw =
      (BigInt(quote.netOutputRaw) * tokenInputRaw) / BigInt(quote.tokenInputRaw);
    instructions.push(
      Object.freeze({
        lotId: lot.lotId,
        walletAddress: lot.walletAddress,
        routeQuoteId: quote.quoteId,
        tokenInputRaw,
        expectedNetOutputRaw,
      }),
    );
    remaining -= tokenInputRaw;
  }
  return Object.freeze(instructions);
}

export function decidePrincipalFirstExit(input: {
  position: AggregatePosition;
  lots: readonly PositionLot[];
  quotesByLotId: ReadonlyMap<string, RouteQuote>;
  actualRecoveredProceedsRaw: bigint;
  initialTotalTokenRaw: bigint;
  runner: RunnerState;
  nowMs: number;
  config: ExitPolicyConfig;
}): ExitPolicyDecision {
  validateBps("recoverPrincipalMultipleBps", input.config.recoverPrincipalMultipleBps);
  validateBps("secondProfitMultipleBps", input.config.secondProfitMultipleBps);
  validateBps("secondProfitTokenShareBps", input.config.secondProfitTokenShareBps, 10_000);
  validateBps("runnerDrawdownBps", input.config.runnerDrawdownBps, 10_000);
  if (
    input.config.runnerMaximumHoldingMs <= 0 ||
    !Number.isSafeInteger(input.config.runnerMaximumHoldingMs)
  ) {
    throw new RangeError("runnerMaximumHoldingMs must be a positive safe integer");
  }
  if (input.config.momentumFailurePolicyId !== "DISABLED_UNTIL_REPLAY_V1") {
    throw new Error("runner momentum exits remain disabled until replay validation");
  }
  if (input.position.executableNetLiquidationRaw.state !== "KNOWN") {
    return Object.freeze({
      decisionId: `exit-decision:${stableHash({ positionId: input.position.positionId, state: "unknown" })}`,
      stage: "HOLD",
      trigger: "executable net liquidation value is unknown",
      instructions: Object.freeze([]),
      updatedRunnerPeakRaw: input.runner.executableNetPeakRaw,
    });
  }
  const cost = BigInt(input.position.totalActualCostRaw);
  const liquidation = BigInt(input.position.executableNetLiquidationRaw.value);
  const totalEconomicValue = input.actualRecoveredProceedsRaw + liquidation;
  const updatedRunnerPeakRaw =
    liquidation > input.runner.executableNetPeakRaw
      ? liquidation
      : input.runner.executableNetPeakRaw;
  const recoveryTrigger =
    totalEconomicValue * 10_000n >= cost * BigInt(input.config.recoverPrincipalMultipleBps);
  let stage: ExitPolicyDecision["stage"] = "HOLD";
  let trigger = "no exit threshold reached";
  let instructions: readonly LotExitInstruction[] = Object.freeze([]);

  if (input.actualRecoveredProceedsRaw < cost && recoveryTrigger) {
    stage = "RECOVER_PRINCIPAL";
    trigger = "executable economic value reached principal-recovery multiple";
    instructions = allocateByNetTarget(
      input.lots,
      input.quotesByLotId,
      cost - input.actualRecoveredProceedsRaw,
    );
  } else if (
    input.actualRecoveredProceedsRaw >= cost &&
    totalEconomicValue * 10_000n >= cost * BigInt(input.config.secondProfitMultipleBps)
  ) {
    stage = "TAKE_SECOND_PROFIT";
    trigger = "executable economic value reached second-profit multiple";
    instructions = allocateByTokenTarget(
      input.lots,
      input.quotesByLotId,
      (input.initialTotalTokenRaw * BigInt(input.config.secondProfitTokenShareBps)) / 10_000n,
    );
  } else if (input.actualRecoveredProceedsRaw >= cost) {
    const drawdown =
      updatedRunnerPeakRaw > 0n &&
      liquidation * 10_000n <=
        updatedRunnerPeakRaw * BigInt(10_000 - input.config.runnerDrawdownBps);
    const timedOut =
      input.nowMs - input.runner.positionOpenedAtMs >= input.config.runnerMaximumHoldingMs;
    if (drawdown || timedOut) {
      stage = "RUNNER";
      trigger = drawdown
        ? "runner executable net value hit drawdown"
        : "runner maximum holding time elapsed";
      instructions = allocateByTokenTarget(
        input.lots,
        input.quotesByLotId,
        BigInt(input.position.remainingQuantityRaw),
      );
    } else if (liquidation === 0n && BigInt(input.position.remainingQuantityRaw) > 0n) {
      stage = "DUST_CLOSE";
      trigger = "residual position has no economically executable net output";
    }
  }
  return Object.freeze({
    decisionId: `exit-decision:${stableHash({
      positionId: input.position.positionId,
      revision: input.position.revision,
      stage,
      totalEconomicValue: totalEconomicValue.toString(),
      actualRecoveredProceedsRaw: input.actualRecoveredProceedsRaw.toString(),
      quoteIds: [...input.quotesByLotId.values()].map((quote) => quote.quoteId).sort(),
    })}`,
    stage,
    trigger,
    instructions,
    updatedRunnerPeakRaw,
  });
}
