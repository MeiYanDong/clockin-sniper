import { stableHash } from "../core/canonical.js";
import type { CapPolicy, CatchUpPolicy } from "../entry/lane-orchestrator.js";
import type { CaGateMode } from "../identity/authorization.js";
import type { FirstLaunchMode } from "../strategies/strategy-router.js";

export type PriceSourcePolicy = "DUAL_SOURCE_WITH_FROZEN_MANUAL_FALLBACK";
export type InitialStopLossBasis = "POST_ENTRY_EXECUTABLE_NET_BASELINE";
export type NoLiquidityPolicy = "ALERT_AND_RETRY_VERIFIED_ROUTES";
export type AutomaticTopUpPolicy = "DISABLED";
export type DeploymentTopology = "ONE_ACTIVE_ONE_KEYLESS_OBSERVER";

export interface ProductionStrategyConfig {
  readonly configId: string;
  readonly revision: number;
  readonly owner: string;
  readonly chainId: 4663;
  readonly clockInBudgetUsdMicros: bigint;
  readonly allInRiskCapUsdMicros: bigint;
  readonly laneCount: 10;
  readonly nominalLaneUsdMicros: bigint;
  readonly minimumShrunkLaneUsdMicros: bigint;
  readonly firstLaunchMode: FirstLaunchMode;
  readonly caGateMode: CaGateMode;
  readonly capPolicy: CapPolicy;
  readonly catchUpPolicy: CatchUpPolicy;
  readonly maxConcurrentCatchUpLanes: number;
  readonly principalRecoveryMultipleBps: number;
  readonly secondProfitMultipleBps: number;
  readonly secondProfitTokenShareBps: number;
  readonly runnerDrawdownBps: number;
  readonly priceSourcePolicy: PriceSourcePolicy;
  readonly priceMaximumAgeMs: number;
  readonly priceMaximumDeviationBps: number;
  readonly prePrincipalMaximumHoldingMs: number;
  readonly runnerMaximumHoldingMs: number;
  readonly momentumFailurePolicyId: "DISABLED_UNTIL_REPLAY_V1";
  readonly initialStopLossBasis: InitialStopLossBasis;
  readonly initialStopLossBps: number;
  readonly stopLossConfirmationBlocks: number;
  readonly routineExitMaximumSlippageBps: number;
  readonly breakGlassExitMaximumSlippageBps: number;
  readonly noLiquidityPolicy: NoLiquidityPolicy;
  readonly authorizationMaximumTtlMs: number;
  readonly maximumSellTransactionsPerWallet: number;
  readonly gasSafetyMarginBps: number;
  readonly automaticTopUpPolicy: AutomaticTopUpPolicy;
  readonly deploymentTopology: DeploymentTopology;
  readonly changedAt: string;
}

export interface FrozenStrategyConfig extends ProductionStrategyConfig {
  /** Owner policy completeness only; protocol evidence and funding have separate readiness gates. */
  readonly productionArmable: boolean;
  readonly configHash: string;
  readonly blockers: readonly string[];
}

export interface StrategyParameterDefinition {
  readonly key: keyof ProductionStrategyConfig;
  readonly owner: "PROJECT_OWNER" | "PROTOCOL_EVIDENCE";
  readonly defaultValue: string | number;
  readonly allowed: string;
  readonly changeControl: string;
}

const ownerChange = "new revision, changedAt, config hash, review, and readiness re-evaluation";
const protocolChange = "new evidence ID, profile revision, config hash, and fail-closed review";

export const STRATEGY_PARAMETER_SCHEMA = Object.freeze([
  {
    key: "configId",
    owner: "PROJECT_OWNER",
    defaultValue: "clockin-policy-v2",
    allowed: "clockin-policy-v2",
    changeControl: ownerChange,
  },
  {
    key: "revision",
    owner: "PROJECT_OWNER",
    defaultValue: 2,
    allowed: "exactly 2",
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
    allowed: "exactly 50000000",
    changeControl: ownerChange,
  },
  {
    key: "allInRiskCapUsdMicros",
    owner: "PROJECT_OWNER",
    defaultValue: "60000000",
    allowed: "exactly 60000000",
    changeControl: ownerChange,
  },
  {
    key: "laneCount",
    owner: "PROJECT_OWNER",
    defaultValue: 10,
    allowed: "exactly 10",
    changeControl: ownerChange,
  },
  {
    key: "nominalLaneUsdMicros",
    owner: "PROJECT_OWNER",
    defaultValue: "5000000",
    allowed: "exactly 5000000",
    changeControl: ownerChange,
  },
  {
    key: "minimumShrunkLaneUsdMicros",
    owner: "PROJECT_OWNER",
    defaultValue: "1000000",
    allowed: "exactly 1000000",
    changeControl: ownerChange,
  },
  {
    key: "firstLaunchMode",
    owner: "PROJECT_OWNER",
    defaultValue: "MONITOR_ONLY",
    allowed: "MONITOR_ONLY",
    changeControl: ownerChange,
  },
  {
    key: "caGateMode",
    owner: "PROJECT_OWNER",
    defaultValue: "HYBRID_CA_GATE",
    allowed: "HYBRID_CA_GATE",
    changeControl: ownerChange,
  },
  {
    key: "capPolicy",
    owner: "PROJECT_OWNER",
    defaultValue: "SHRINK_TO_CAP",
    allowed: "SHRINK_TO_CAP",
    changeControl: ownerChange,
  },
  {
    key: "catchUpPolicy",
    owner: "PROJECT_OWNER",
    defaultValue: "QUOTE_RANKED_BOUNDED",
    allowed: "QUOTE_RANKED_BOUNDED",
    changeControl: ownerChange,
  },
  {
    key: "maxConcurrentCatchUpLanes",
    owner: "PROJECT_OWNER",
    defaultValue: 2,
    allowed: "exactly 2",
    changeControl: ownerChange,
  },
  {
    key: "principalRecoveryMultipleBps",
    owner: "PROJECT_OWNER",
    defaultValue: 20_000,
    allowed: "exactly 20000 bps",
    changeControl: ownerChange,
  },
  {
    key: "secondProfitMultipleBps",
    owner: "PROJECT_OWNER",
    defaultValue: 30_000,
    allowed: "exactly 30000 bps",
    changeControl: ownerChange,
  },
  {
    key: "secondProfitTokenShareBps",
    owner: "PROJECT_OWNER",
    defaultValue: 1_000,
    allowed: "exactly 1000 bps",
    changeControl: ownerChange,
  },
  {
    key: "runnerDrawdownBps",
    owner: "PROJECT_OWNER",
    defaultValue: 2_500,
    allowed: "exactly 2500 bps",
    changeControl: ownerChange,
  },
  {
    key: "priceSourcePolicy",
    owner: "PROJECT_OWNER",
    defaultValue: "DUAL_SOURCE_WITH_FROZEN_MANUAL_FALLBACK",
    allowed: "dual source; manual fallback frozen before arming",
    changeControl: ownerChange,
  },
  {
    key: "priceMaximumAgeMs",
    owner: "PROJECT_OWNER",
    defaultValue: 30_000,
    allowed: "exactly 30000 ms",
    changeControl: ownerChange,
  },
  {
    key: "priceMaximumDeviationBps",
    owner: "PROJECT_OWNER",
    defaultValue: 200,
    allowed: "exactly 200 bps",
    changeControl: ownerChange,
  },
  {
    key: "prePrincipalMaximumHoldingMs",
    owner: "PROJECT_OWNER",
    defaultValue: 3_600_000,
    allowed: "exactly 60 minutes",
    changeControl: ownerChange,
  },
  {
    key: "runnerMaximumHoldingMs",
    owner: "PROJECT_OWNER",
    defaultValue: 86_400_000,
    allowed: "exactly 24 hours",
    changeControl: ownerChange,
  },
  {
    key: "momentumFailurePolicyId",
    owner: "PROJECT_OWNER",
    defaultValue: "DISABLED_UNTIL_REPLAY_V1",
    allowed: "DISABLED_UNTIL_REPLAY_V1",
    changeControl: ownerChange,
  },
  {
    key: "initialStopLossBasis",
    owner: "PROJECT_OWNER",
    defaultValue: "POST_ENTRY_EXECUTABLE_NET_BASELINE",
    allowed: "POST_ENTRY_EXECUTABLE_NET_BASELINE",
    changeControl: ownerChange,
  },
  {
    key: "initialStopLossBps",
    owner: "PROJECT_OWNER",
    defaultValue: 3_000,
    allowed: "exactly 3000 bps",
    changeControl: ownerChange,
  },
  {
    key: "stopLossConfirmationBlocks",
    owner: "PROJECT_OWNER",
    defaultValue: 2,
    allowed: "exactly 2 canonical blocks",
    changeControl: ownerChange,
  },
  {
    key: "routineExitMaximumSlippageBps",
    owner: "PROJECT_OWNER",
    defaultValue: 500,
    allowed: "exactly 500 bps",
    changeControl: ownerChange,
  },
  {
    key: "breakGlassExitMaximumSlippageBps",
    owner: "PROJECT_OWNER",
    defaultValue: 2_000,
    allowed: "exactly 2000 bps; explicit second confirmation only",
    changeControl: ownerChange,
  },
  {
    key: "noLiquidityPolicy",
    owner: "PROJECT_OWNER",
    defaultValue: "ALERT_AND_RETRY_VERIFIED_ROUTES",
    allowed: "ALERT_AND_RETRY_VERIFIED_ROUTES",
    changeControl: ownerChange,
  },
  {
    key: "authorizationMaximumTtlMs",
    owner: "PROJECT_OWNER",
    defaultValue: 604_800_000,
    allowed: "at most 7 days",
    changeControl: ownerChange,
  },
  {
    key: "maximumSellTransactionsPerWallet",
    owner: "PROJECT_OWNER",
    defaultValue: 3,
    allowed: "exactly 3",
    changeControl: ownerChange,
  },
  {
    key: "gasSafetyMarginBps",
    owner: "PROJECT_OWNER",
    defaultValue: 3_000,
    allowed: "exactly 3000 bps",
    changeControl: ownerChange,
  },
  {
    key: "automaticTopUpPolicy",
    owner: "PROJECT_OWNER",
    defaultValue: "DISABLED",
    allowed: "DISABLED",
    changeControl: ownerChange,
  },
  {
    key: "deploymentTopology",
    owner: "PROJECT_OWNER",
    defaultValue: "ONE_ACTIVE_ONE_KEYLESS_OBSERVER",
    allowed: "ONE_ACTIVE_ONE_KEYLESS_OBSERVER",
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

function positiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function assertExact<T>(name: string, actual: T, expected: T): void {
  if (actual !== expected) throw new RangeError(`${name} must be ${String(expected)} in policy v2`);
}

export function freezeStrategyConfig(config: ProductionStrategyConfig): FrozenStrategyConfig {
  if (config.configId !== "clockin-policy-v2")
    throw new Error("policy v2 requires its stable config ID");
  assertExact("revision", config.revision, 2);
  if (config.owner.trim().length === 0) throw new RangeError("strategy owner is required");
  assertExact("chainId", config.chainId, 4663);
  assertExact("clockInBudgetUsdMicros", config.clockInBudgetUsdMicros, 50_000_000n);
  assertExact("allInRiskCapUsdMicros", config.allInRiskCapUsdMicros, 60_000_000n);
  assertExact("laneCount", config.laneCount, 10);
  assertExact("nominalLaneUsdMicros", config.nominalLaneUsdMicros, 5_000_000n);
  assertExact("minimumShrunkLaneUsdMicros", config.minimumShrunkLaneUsdMicros, 1_000_000n);
  if (config.nominalLaneUsdMicros * BigInt(config.laneCount) !== config.clockInBudgetUsdMicros) {
    throw new RangeError("ClockIn policy must be 10 one-shot lanes of nominal 5U");
  }
  assertExact("firstLaunchMode", config.firstLaunchMode, "MONITOR_ONLY");
  assertExact("caGateMode", config.caGateMode, "HYBRID_CA_GATE");
  assertExact("capPolicy", config.capPolicy, "SHRINK_TO_CAP");
  assertExact("catchUpPolicy", config.catchUpPolicy, "QUOTE_RANKED_BOUNDED");
  assertExact("maxConcurrentCatchUpLanes", config.maxConcurrentCatchUpLanes, 2);
  assertExact("principalRecoveryMultipleBps", config.principalRecoveryMultipleBps, 20_000);
  assertExact("secondProfitMultipleBps", config.secondProfitMultipleBps, 30_000);
  assertExact("secondProfitTokenShareBps", config.secondProfitTokenShareBps, 1_000);
  assertExact("runnerDrawdownBps", config.runnerDrawdownBps, 2_500);
  bps("principalRecoveryMultipleBps", config.principalRecoveryMultipleBps);
  bps("secondProfitMultipleBps", config.secondProfitMultipleBps);
  bps("secondProfitTokenShareBps", config.secondProfitTokenShareBps, 10_000);
  bps("runnerDrawdownBps", config.runnerDrawdownBps, 10_000);
  assertExact(
    "priceSourcePolicy",
    config.priceSourcePolicy,
    "DUAL_SOURCE_WITH_FROZEN_MANUAL_FALLBACK",
  );
  assertExact("priceMaximumAgeMs", config.priceMaximumAgeMs, 30_000);
  assertExact("priceMaximumDeviationBps", config.priceMaximumDeviationBps, 200);
  assertExact("prePrincipalMaximumHoldingMs", config.prePrincipalMaximumHoldingMs, 3_600_000);
  assertExact("runnerMaximumHoldingMs", config.runnerMaximumHoldingMs, 86_400_000);
  assertExact(
    "momentumFailurePolicyId",
    config.momentumFailurePolicyId,
    "DISABLED_UNTIL_REPLAY_V1",
  );
  assertExact(
    "initialStopLossBasis",
    config.initialStopLossBasis,
    "POST_ENTRY_EXECUTABLE_NET_BASELINE",
  );
  assertExact("initialStopLossBps", config.initialStopLossBps, 3_000);
  assertExact("stopLossConfirmationBlocks", config.stopLossConfirmationBlocks, 2);
  assertExact("routineExitMaximumSlippageBps", config.routineExitMaximumSlippageBps, 500);
  assertExact("breakGlassExitMaximumSlippageBps", config.breakGlassExitMaximumSlippageBps, 2_000);
  assertExact("noLiquidityPolicy", config.noLiquidityPolicy, "ALERT_AND_RETRY_VERIFIED_ROUTES");
  assertExact("authorizationMaximumTtlMs", config.authorizationMaximumTtlMs, 604_800_000);
  assertExact("maximumSellTransactionsPerWallet", config.maximumSellTransactionsPerWallet, 3);
  assertExact("gasSafetyMarginBps", config.gasSafetyMarginBps, 3_000);
  assertExact("automaticTopUpPolicy", config.automaticTopUpPolicy, "DISABLED");
  assertExact("deploymentTopology", config.deploymentTopology, "ONE_ACTIVE_ONE_KEYLESS_OBSERVER");
  positiveSafeInteger("priceMaximumAgeMs", config.priceMaximumAgeMs);
  bps("priceMaximumDeviationBps", config.priceMaximumDeviationBps, 10_000);
  positiveSafeInteger("prePrincipalMaximumHoldingMs", config.prePrincipalMaximumHoldingMs);
  positiveSafeInteger("runnerMaximumHoldingMs", config.runnerMaximumHoldingMs);
  bps("initialStopLossBps", config.initialStopLossBps, 10_000);
  positiveSafeInteger("stopLossConfirmationBlocks", config.stopLossConfirmationBlocks);
  bps("routineExitMaximumSlippageBps", config.routineExitMaximumSlippageBps, 9_999);
  bps("breakGlassExitMaximumSlippageBps", config.breakGlassExitMaximumSlippageBps, 9_999);
  if (config.routineExitMaximumSlippageBps >= config.breakGlassExitMaximumSlippageBps) {
    throw new RangeError("routine exit slippage must remain below break-glass slippage");
  }
  positiveSafeInteger("authorizationMaximumTtlMs", config.authorizationMaximumTtlMs);
  positiveSafeInteger("maximumSellTransactionsPerWallet", config.maximumSellTransactionsPerWallet);
  bps("gasSafetyMarginBps", config.gasSafetyMarginBps, 10_000);
  if (!Number.isFinite(Date.parse(config.changedAt)))
    throw new TypeError("changedAt must be ISO-8601");

  const canonical = {
    ...config,
    clockInBudgetUsdMicros: config.clockInBudgetUsdMicros.toString(),
    allInRiskCapUsdMicros: config.allInRiskCapUsdMicros.toString(),
    nominalLaneUsdMicros: config.nominalLaneUsdMicros.toString(),
    minimumShrunkLaneUsdMicros: config.minimumShrunkLaneUsdMicros.toString(),
  };
  return Object.freeze({
    ...config,
    configHash: stableHash(canonical),
    productionArmable: true,
    blockers: Object.freeze([]),
  });
}

export const CLOCKIN_POLICY_V2 = freezeStrategyConfig({
  configId: "clockin-policy-v2",
  revision: 2,
  owner: "project-owner",
  chainId: 4663,
  clockInBudgetUsdMicros: 50_000_000n,
  allInRiskCapUsdMicros: 60_000_000n,
  laneCount: 10,
  nominalLaneUsdMicros: 5_000_000n,
  minimumShrunkLaneUsdMicros: 1_000_000n,
  firstLaunchMode: "MONITOR_ONLY",
  caGateMode: "HYBRID_CA_GATE",
  capPolicy: "SHRINK_TO_CAP",
  catchUpPolicy: "QUOTE_RANKED_BOUNDED",
  maxConcurrentCatchUpLanes: 2,
  principalRecoveryMultipleBps: 20_000,
  secondProfitMultipleBps: 30_000,
  secondProfitTokenShareBps: 1_000,
  runnerDrawdownBps: 2_500,
  priceSourcePolicy: "DUAL_SOURCE_WITH_FROZEN_MANUAL_FALLBACK",
  priceMaximumAgeMs: 30_000,
  priceMaximumDeviationBps: 200,
  prePrincipalMaximumHoldingMs: 3_600_000,
  runnerMaximumHoldingMs: 86_400_000,
  momentumFailurePolicyId: "DISABLED_UNTIL_REPLAY_V1",
  initialStopLossBasis: "POST_ENTRY_EXECUTABLE_NET_BASELINE",
  initialStopLossBps: 3_000,
  stopLossConfirmationBlocks: 2,
  routineExitMaximumSlippageBps: 500,
  breakGlassExitMaximumSlippageBps: 2_000,
  noLiquidityPolicy: "ALERT_AND_RETRY_VERIFIED_ROUTES",
  authorizationMaximumTtlMs: 604_800_000,
  maximumSellTransactionsPerWallet: 3,
  gasSafetyMarginBps: 3_000,
  automaticTopUpPolicy: "DISABLED",
  deploymentTopology: "ONE_ACTIVE_ONE_KEYLESS_OBSERVER",
  changedAt: "2026-08-16T00:00:00.000Z",
});

/** Compatibility alias for callers that previously imported the initial policy. */
export const INITIAL_CLOCKIN_POLICY = CLOCKIN_POLICY_V2;
