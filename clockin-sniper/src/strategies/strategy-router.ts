import { stableHash, type LaunchIdentity } from "../core/canonical.js";

export const CLOCKIN_STRATEGY_ID = "clockin-mainnet-v1";
export const FIRST_OFFICIAL_LAUNCH_STRATEGY_ID = "first-official-launch-v1";

export type FirstLaunchMode = "MONITOR_ONLY" | "INDEPENDENT_5U_CANARY";

export interface StrategyRoutingDecision {
  readonly launchId: string;
  readonly ownerStrategyId: string;
  readonly clockIn: "EXECUTE" | "IGNORE";
  readonly firstOfficialLaunch: "MONITOR" | "EXECUTE_CANARY" | "DEDUPED_TO_CLOCKIN" | "IGNORE";
  readonly budgetId: string;
  readonly reason: string;
}

export interface StrategyRouterConfig {
  readonly firstLaunchMode: FirstLaunchMode;
  readonly firstLaunchBudgetUsdMicros: bigint;
}

export interface OfficialLaunchEligibility {
  readonly identity: LaunchIdentity;
  readonly factoryVerified: boolean;
  readonly creatorAuthorized: boolean;
  readonly testLaunch: boolean;
  readonly removed: boolean;
}

export function selectCanonicalFirstOfficialLaunch(
  candidates: readonly OfficialLaunchEligibility[],
): LaunchIdentity | null {
  const eligible = candidates
    .filter(
      (candidate) =>
        candidate.factoryVerified &&
        candidate.creatorAuthorized &&
        !candidate.testLaunch &&
        !candidate.removed,
    )
    .map((candidate) => candidate.identity)
    .sort((left, right) => {
      const leftBlock = BigInt(left.blockNumber);
      const rightBlock = BigInt(right.blockNumber);
      if (leftBlock !== rightBlock) return leftBlock < rightBlock ? -1 : 1;
      const leftTransaction = BigInt(left.transactionIndex);
      const rightTransaction = BigInt(right.transactionIndex);
      if (leftTransaction !== rightTransaction) {
        return leftTransaction < rightTransaction ? -1 : 1;
      }
      const leftLog = BigInt(left.logIndex);
      const rightLog = BigInt(right.logIndex);
      return leftLog < rightLog ? -1 : leftLog > rightLog ? 1 : 0;
    });
  return eligible[0] ?? null;
}

export class StrategyRouter {
  readonly #config: StrategyRouterConfig;
  #firstOfficialLaunchId: string | null = null;

  constructor(config: StrategyRouterConfig) {
    if (config.firstLaunchMode === "MONITOR_ONLY" && config.firstLaunchBudgetUsdMicros !== 0n) {
      throw new RangeError("monitor-only first-launch strategy must have a zero budget");
    }
    if (
      config.firstLaunchMode === "INDEPENDENT_5U_CANARY" &&
      config.firstLaunchBudgetUsdMicros !== 5_000_000n
    ) {
      throw new RangeError("first-launch canary budget must be exactly 5U");
    }
    this.#config = Object.freeze({ ...config });
  }

  route(
    identity: LaunchIdentity,
    isClockIn: boolean,
    isValidOfficialLaunch: boolean,
  ): StrategyRoutingDecision {
    if (isValidOfficialLaunch && this.#firstOfficialLaunchId === null) {
      this.#firstOfficialLaunchId = identity.launchId;
    }
    const isFirst = this.#firstOfficialLaunchId === identity.launchId;
    if (isClockIn) {
      return Object.freeze({
        launchId: identity.launchId,
        ownerStrategyId: CLOCKIN_STRATEGY_ID,
        clockIn: "EXECUTE",
        firstOfficialLaunch: isFirst ? "DEDUPED_TO_CLOCKIN" : "IGNORE",
        budgetId: `${CLOCKIN_STRATEGY_ID}:${stableHash(identity.configHash)}`,
        reason: isFirst
          ? "same CA belongs to ClockIn and first-official-launch; ClockIn owns the capital"
          : "ClockIn identity matched",
      });
    }
    if (!isFirst) {
      return Object.freeze({
        launchId: identity.launchId,
        ownerStrategyId: FIRST_OFFICIAL_LAUNCH_STRATEGY_ID,
        clockIn: "IGNORE",
        firstOfficialLaunch: "IGNORE",
        budgetId: `${FIRST_OFFICIAL_LAUNCH_STRATEGY_ID}:none`,
        reason: "not the canonical first valid official launch",
      });
    }
    const execute = this.#config.firstLaunchMode === "INDEPENDENT_5U_CANARY";
    return Object.freeze({
      launchId: identity.launchId,
      ownerStrategyId: FIRST_OFFICIAL_LAUNCH_STRATEGY_ID,
      clockIn: "IGNORE",
      firstOfficialLaunch: execute ? "EXECUTE_CANARY" : "MONITOR",
      budgetId: execute
        ? `${FIRST_OFFICIAL_LAUNCH_STRATEGY_ID}:${stableHash(identity.configHash)}`
        : `${FIRST_OFFICIAL_LAUNCH_STRATEGY_ID}:monitor-only`,
      reason: execute ? "independent 5U canary authorized" : "monitor-only budget is 0U",
    });
  }
}
