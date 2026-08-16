import type { EffectRecord, ExecutionPlan } from "../core/canonical.js";
import type { StrategyRoutingDecision } from "./strategy-router.js";

export interface StrategyMetricSnapshot {
  readonly strategyId: string;
  readonly routingDecisions: number;
  readonly executionPlans: number;
  readonly canonicalEffects: number;
  readonly failedEffects: number;
  readonly actualPrincipalRaw: bigint;
}

interface MutableMetrics {
  routingDecisions: number;
  executionPlans: number;
  canonicalEffects: number;
  failedEffects: number;
  actualPrincipalRaw: bigint;
}

export class StrategyMetricsLedger {
  readonly #metrics = new Map<string, MutableMetrics>();

  recordRoutingDecision(decision: StrategyRoutingDecision): void {
    this.#for(decision.ownerStrategyId).routingDecisions += 1;
  }

  recordExecutionPlan(plan: ExecutionPlan): void {
    const metrics = this.#for(plan.strategyId);
    metrics.executionPlans += 1;
    metrics.actualPrincipalRaw += BigInt(plan.valueRaw);
  }

  recordEffect(effect: EffectRecord): void {
    const metrics = this.#for(effect.strategyId);
    if (effect.canonicality === "CANONICAL" && effect.result === "SUCCESS") {
      metrics.canonicalEffects += 1;
    } else if (effect.result !== "UNKNOWN") {
      metrics.failedEffects += 1;
    }
  }

  snapshot(strategyId: string): StrategyMetricSnapshot {
    return Object.freeze({ strategyId, ...this.#for(strategyId) });
  }

  #for(strategyId: string): MutableMetrics {
    const current = this.#metrics.get(strategyId);
    if (current !== undefined) return current;
    const created: MutableMetrics = {
      routingDecisions: 0,
      executionPlans: 0,
      canonicalEffects: 0,
      failedEffects: 0,
      actualPrincipalRaw: 0n,
    };
    this.#metrics.set(strategyId, created);
    return created;
  }
}
