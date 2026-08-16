import { stableHash } from "../core/canonical.js";
import type { CaGateMode } from "../identity/authorization.js";
import type { CapPolicy, CatchUpPolicy } from "../entry/lane-orchestrator.js";
import type { FirstLaunchMode } from "../strategies/strategy-router.js";

export interface ProductionStrategyConfig {
  readonly configId: string;
  readonly revision: number;
  readonly owner: string;
  readonly chainId: 4663;
  readonly clockInBudgetUsdMicros: bigint;
  readonly laneCount: 10;
  readonly nominalLaneUsdMicros: bigint;
  readonly firstLaunchMode: FirstLaunchMode;
  readonly caGateMode: CaGateMode;
  readonly capPolicy: CapPolicy;
  readonly catchUpPolicy: CatchUpPolicy;
  readonly maxConcurrentCatchUpLanes: number;
  readonly principalRecoveryMultipleBps: number;
  readonly secondProfitMultipleBps: number;
  readonly secondProfitTokenShareBps: number;
  readonly runnerDrawdownBps: number;
  readonly priceMaximumAgeMs: number | null;
  readonly priceMaximumDeviationBps: number | null;
  readonly maximumHoldingMs: number | null;
  readonly momentumFailurePolicyId: string | null;
  readonly initialStopLossBps: number | null;
  readonly manualExitMaximumSlippageBps: number | null;
  readonly noLiquidityPolicy: "ALERT_AND_HOLD";
  readonly changedAt: string;
}

export interface FrozenStrategyConfig extends ProductionStrategyConfig {
  readonly configHash: string;
  readonly productionArmable: boolean;
  readonly blockers: readonly string[];
}

export interface StrategyParameterDefinition {
  readonly key: keyof ProductionStrategyConfig;
  readonly owner: "PROJECT_OWNER" | "PROTOCOL_EVIDENCE";
  readonly defaultValue: string | number | null;
  readonly allowed: string;
  readonly changeControl: string;
}

const ownerChange = "new revision, changedAt, config hash, review, and readiness re-evaluation";
const protocolChange = "new evidence ID, profile revision, config hash, and fail-closed review";

export const STRATEGY_PARAMETER_SCHEMA = Object.freeze([
  {
    key: "configId",
    owner: "PROJECT_OWNER",
    defaultValue: "clockin-policy-v1",
    allowed: "non-empty stable ID",
    changeControl: ownerChange,
  },
  {
    key: "revision",
    owner: "PROJECT_OWNER",
    defaultValue: 1,
    allowed: "integer >= 1",
    changeControl: ownerChange,
  },
  {
    key: "owner",
    owner: "PROJECT_OWNER",
    defaultValue: "project-owner",
    allowed: "named accountable owner",
    changeControl: ownerChange,
  },
  {
    key: "chainId",
    owner: "PROTOCOL_EVIDENCE",
    defaultValue: 4663,
    allowed: "4663",
    changeControl: protocolChange,
  },
  {
    key: "clockInBudgetUsdMicros",
    owner: "PROJECT_OWNER",
    defaultValue: "50000000",
    allowed: "exactly 50000000 in policy v1",
    changeControl: ownerChange,
  },
  {
    key: "laneCount",
    owner: "PROJECT_OWNER",
    defaultValue: 10,
    allowed: "exactly 10 in policy v1",
    changeControl: ownerChange,
  },
  {
    key: "nominalLaneUsdMicros",
    owner: "PROJECT_OWNER",
    defaultValue: "5000000",
    allowed: "exactly 5000000 in policy v1",
    changeControl: ownerChange,
  },
  {
    key: "firstLaunchMode",
    owner: "PROJECT_OWNER",
    defaultValue: "MONITOR_ONLY",
    allowed: "MONITOR_ONLY in policy v1",
    changeControl: ownerChange,
  },
  {
    key: "caGateMode",
    owner: "PROJECT_OWNER",
    defaultValue: "HYBRID_CA_GATE",
    allowed: "HYBRID_CA_GATE in policy v1",
    changeControl: ownerChange,
  },
  {
    key: "capPolicy",
    owner: "PROJECT_OWNER",
    defaultValue: "STRICT_5U",
    allowed: "STRICT_5U in policy v1",
    changeControl: ownerChange,
  },
  {
    key: "catchUpPolicy",
    owner: "PROJECT_OWNER",
    defaultValue: "QUOTE_RANKED_BOUNDED",
    allowed: "QUOTE_RANKED_BOUNDED in policy v1",
    changeControl: ownerChange,
  },
  {
    key: "maxConcurrentCatchUpLanes",
    owner: "PROJECT_OWNER",
    defaultValue: 2,
    allowed: "exactly 2 in policy v1",
    changeControl: ownerChange,
  },
  {
    key: "principalRecoveryMultipleBps",
    owner: "PROJECT_OWNER",
    defaultValue: 20000,
    allowed: "0..100000 bps",
    changeControl: ownerChange,
  },
  {
    key: "secondProfitMultipleBps",
    owner: "PROJECT_OWNER",
    defaultValue: 30000,
    allowed: "0..100000 bps",
    changeControl: ownerChange,
  },
  {
    key: "secondProfitTokenShareBps",
    owner: "PROJECT_OWNER",
    defaultValue: 1000,
    allowed: "0..10000 bps",
    changeControl: ownerChange,
  },
  {
    key: "runnerDrawdownBps",
    owner: "PROJECT_OWNER",
    defaultValue: 2500,
    allowed: "0..10000 bps",
    changeControl: ownerChange,
  },
  {
    key: "priceMaximumAgeMs",
    owner: "PROJECT_OWNER",
    defaultValue: null,
    allowed: "null (blocked) or integer > 0",
    changeControl: ownerChange,
  },
  {
    key: "priceMaximumDeviationBps",
    owner: "PROJECT_OWNER",
    defaultValue: null,
    allowed: "null (blocked) or 0..10000 bps",
    changeControl: ownerChange,
  },
  {
    key: "maximumHoldingMs",
    owner: "PROJECT_OWNER",
    defaultValue: null,
    allowed: "null (blocked) or integer > 0",
    changeControl: ownerChange,
  },
  {
    key: "momentumFailurePolicyId",
    owner: "PROJECT_OWNER",
    defaultValue: null,
    allowed: "null (blocked) or versioned policy ID",
    changeControl: ownerChange,
  },
  {
    key: "initialStopLossBps",
    owner: "PROJECT_OWNER",
    defaultValue: null,
    allowed: "null (blocked) or 0..10000 bps",
    changeControl: ownerChange,
  },
  {
    key: "manualExitMaximumSlippageBps",
    owner: "PROJECT_OWNER",
    defaultValue: null,
    allowed: "null (blocked) or 0..9999 bps",
    changeControl: ownerChange,
  },
  {
    key: "noLiquidityPolicy",
    owner: "PROJECT_OWNER",
    defaultValue: "ALERT_AND_HOLD",
    allowed: "ALERT_AND_HOLD in policy v1",
    changeControl: ownerChange,
  },
  {
    key: "changedAt",
    owner: "PROJECT_OWNER",
    defaultValue: "2026-08-16T00:00:00.000Z",
    allowed: "ISO-8601 timestamp",
    changeControl: ownerChange,
  },
] satisfies ReadonlyArray<StrategyParameterDefinition>);

function bps(name: string, value: number, maximum = 100_000): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} is outside its supported range`);
  }
}

export function freezeStrategyConfig(config: ProductionStrategyConfig): FrozenStrategyConfig {
  if (config.revision < 1 || !Number.isSafeInteger(config.revision)) {
    throw new RangeError("config revision must be a positive integer");
  }
  if (config.clockInBudgetUsdMicros !== 50_000_000n) {
    throw new RangeError("ClockIn budget must be exactly 50U for policy v1");
  }
  if (
    config.laneCount !== 10 ||
    config.nominalLaneUsdMicros !== 5_000_000n ||
    config.nominalLaneUsdMicros * BigInt(config.laneCount) !== config.clockInBudgetUsdMicros
  ) {
    throw new RangeError("ClockIn policy must be 10 one-shot lanes of nominal 5U");
  }
  if (config.firstLaunchMode !== "MONITOR_ONLY") {
    throw new Error("policy v1 keeps the first-official-launch strategy monitor-only");
  }
  if (config.caGateMode !== "HYBRID_CA_GATE") {
    throw new Error("policy v1 requires HYBRID_CA_GATE");
  }
  if (config.capPolicy !== "STRICT_5U") throw new Error("policy v1 requires strict 5U cap");
  if (config.catchUpPolicy !== "QUOTE_RANKED_BOUNDED") {
    throw new Error("policy v1 requires quote-ranked bounded catch-up");
  }
  if (config.maxConcurrentCatchUpLanes !== 2) {
    throw new RangeError("policy v1 permits at most two catch-up lanes per block");
  }
  bps("principalRecoveryMultipleBps", config.principalRecoveryMultipleBps);
  bps("secondProfitMultipleBps", config.secondProfitMultipleBps);
  bps("secondProfitTokenShareBps", config.secondProfitTokenShareBps, 10_000);
  bps("runnerDrawdownBps", config.runnerDrawdownBps, 10_000);
  if (config.priceMaximumAgeMs !== null && config.priceMaximumAgeMs <= 0) {
    throw new RangeError("priceMaximumAgeMs must be positive when configured");
  }
  if (config.priceMaximumDeviationBps !== null) {
    bps("priceMaximumDeviationBps", config.priceMaximumDeviationBps, 10_000);
  }
  if (config.maximumHoldingMs !== null && config.maximumHoldingMs <= 0) {
    throw new RangeError("maximumHoldingMs must be positive when configured");
  }
  if (config.initialStopLossBps !== null)
    bps("initialStopLossBps", config.initialStopLossBps, 10_000);
  if (config.manualExitMaximumSlippageBps !== null) {
    bps("manualExitMaximumSlippageBps", config.manualExitMaximumSlippageBps, 9_999);
  }
  const blockers: string[] = [];
  if (config.priceMaximumAgeMs === null) blockers.push("priceMaximumAgeMs is not decided");
  if (config.priceMaximumDeviationBps === null) {
    blockers.push("priceMaximumDeviationBps is not decided");
  }
  if (config.maximumHoldingMs === null) blockers.push("maximumHoldingMs is not decided");
  if (config.momentumFailurePolicyId === null)
    blockers.push("momentum failure policy is not decided");
  if (config.initialStopLossBps === null) blockers.push("initial stop-loss policy is not decided");
  if (config.manualExitMaximumSlippageBps === null) {
    blockers.push("manual EXIT_NOW maximum slippage is not decided");
  }
  return Object.freeze({
    ...config,
    configHash: stableHash({
      configId: config.configId,
      revision: config.revision,
      owner: config.owner,
      chainId: config.chainId,
      clockInBudgetUsdMicros: config.clockInBudgetUsdMicros.toString(),
      laneCount: config.laneCount,
      nominalLaneUsdMicros: config.nominalLaneUsdMicros.toString(),
      firstLaunchMode: config.firstLaunchMode,
      caGateMode: config.caGateMode,
      capPolicy: config.capPolicy,
      catchUpPolicy: config.catchUpPolicy,
      maxConcurrentCatchUpLanes: config.maxConcurrentCatchUpLanes,
      principalRecoveryMultipleBps: config.principalRecoveryMultipleBps,
      secondProfitMultipleBps: config.secondProfitMultipleBps,
      secondProfitTokenShareBps: config.secondProfitTokenShareBps,
      runnerDrawdownBps: config.runnerDrawdownBps,
      priceMaximumAgeMs: config.priceMaximumAgeMs,
      priceMaximumDeviationBps: config.priceMaximumDeviationBps,
      maximumHoldingMs: config.maximumHoldingMs,
      momentumFailurePolicyId: config.momentumFailurePolicyId,
      initialStopLossBps: config.initialStopLossBps,
      manualExitMaximumSlippageBps: config.manualExitMaximumSlippageBps,
      noLiquidityPolicy: config.noLiquidityPolicy,
      changedAt: config.changedAt,
    }),
    productionArmable: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}

export const INITIAL_CLOCKIN_POLICY = freezeStrategyConfig({
  configId: "clockin-policy-v1",
  revision: 1,
  owner: "project-owner",
  chainId: 4663,
  clockInBudgetUsdMicros: 50_000_000n,
  laneCount: 10,
  nominalLaneUsdMicros: 5_000_000n,
  firstLaunchMode: "MONITOR_ONLY",
  caGateMode: "HYBRID_CA_GATE",
  capPolicy: "STRICT_5U",
  catchUpPolicy: "QUOTE_RANKED_BOUNDED",
  maxConcurrentCatchUpLanes: 2,
  principalRecoveryMultipleBps: 20_000,
  secondProfitMultipleBps: 30_000,
  secondProfitTokenShareBps: 1_000,
  runnerDrawdownBps: 2_500,
  priceMaximumAgeMs: null,
  priceMaximumDeviationBps: null,
  maximumHoldingMs: null,
  momentumFailurePolicyId: null,
  initialStopLossBps: null,
  manualExitMaximumSlippageBps: null,
  noLiquidityPolicy: "ALERT_AND_HOLD",
  changedAt: "2026-08-16T00:00:00.000Z",
});
