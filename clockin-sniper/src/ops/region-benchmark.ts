export type BenchmarkMetric =
  | "WSS_NEW_HEAD"
  | "EXACT_LOG"
  | "ETH_CALL"
  | "SEQUENCER_INVALID_RAW"
  | "RPC_INVALID_RAW";

export interface BenchmarkSample {
  readonly region: string;
  readonly providerId: string;
  readonly metric: BenchmarkMetric;
  readonly success: boolean;
  readonly latencyMs: number;
  readonly observedAt: string;
  readonly networkCondition: string;
}

export interface BenchmarkProbe {
  readonly region: string;
  readonly providerId: string;
  readonly metric: BenchmarkMetric;
  readonly networkCondition: string;
  run(): Promise<void>;
}

export interface BenchmarkSummary {
  readonly region: string;
  readonly providerId: string;
  readonly metric: BenchmarkMetric;
  readonly count: number;
  readonly errorRateBps: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly jitterMs: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly networkConditions: readonly string[];
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] as number;
}

export async function collectBenchmarkSamples(input: {
  probes: readonly BenchmarkProbe[];
  iterations: number;
  now?: () => number;
  isoNow?: () => string;
}): Promise<readonly BenchmarkSample[]> {
  if (!Number.isSafeInteger(input.iterations) || input.iterations < 1) {
    throw new RangeError("benchmark iterations must be a positive integer");
  }
  const now = input.now ?? Date.now;
  const isoNow = input.isoNow ?? (() => new Date().toISOString());
  const samples: BenchmarkSample[] = [];
  for (let iteration = 0; iteration < input.iterations; iteration += 1) {
    for (const probe of input.probes) {
      const startedAt = now();
      let success = true;
      try {
        await probe.run();
      } catch {
        success = false;
      }
      samples.push(
        Object.freeze({
          region: probe.region,
          providerId: probe.providerId,
          metric: probe.metric,
          success,
          latencyMs: Math.max(0, now() - startedAt),
          observedAt: isoNow(),
          networkCondition: probe.networkCondition,
        }),
      );
    }
  }
  return Object.freeze(samples);
}

export function summarizeBenchmark(
  samples: readonly BenchmarkSample[],
): readonly BenchmarkSummary[] {
  const groups = new Map<string, BenchmarkSample[]>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.latencyMs) || sample.latencyMs < 0) {
      throw new RangeError("benchmark latency must be non-negative and finite");
    }
    const key = `${sample.region}\u0000${sample.providerId}\u0000${sample.metric}`;
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return Object.freeze(
    [...groups.values()].map((group) => {
      const first = group[0] as BenchmarkSample;
      const latencies = group.map((sample) => sample.latencyMs).sort((left, right) => left - right);
      const failures = group.filter((sample) => !sample.success).length;
      const observed = group.map((sample) => sample.observedAt).sort();
      return Object.freeze({
        region: first.region,
        providerId: first.providerId,
        metric: first.metric,
        count: group.length,
        errorRateBps: Math.round((failures * 10_000) / group.length),
        p50Ms: percentile(latencies, 0.5),
        p95Ms: percentile(latencies, 0.95),
        p99Ms: percentile(latencies, 0.99),
        jitterMs: (latencies.at(-1) ?? 0) - (latencies[0] ?? 0),
        startedAt: observed[0] ?? "",
        endedAt: observed.at(-1) ?? "",
        networkConditions: Object.freeze(
          [...new Set(group.map((sample) => sample.networkCondition))].sort(),
        ),
      });
    }),
  );
}

export function rankRegions(summaries: readonly BenchmarkSummary[]): readonly Readonly<{
  region: string;
  aggregateErrorRateBps: number;
  worstP95Ms: number;
  worstP99Ms: number;
}>[] {
  const regions = new Map<string, BenchmarkSummary[]>();
  for (const summary of summaries) {
    const group = regions.get(summary.region) ?? [];
    group.push(summary);
    regions.set(summary.region, group);
  }
  const ranked = [...regions.entries()].map(([region, group]) =>
    Object.freeze({
      region,
      aggregateErrorRateBps: Math.round(
        group.reduce((sum, item) => sum + item.errorRateBps, 0) / group.length,
      ),
      worstP95Ms: Math.max(...group.map((item) => item.p95Ms)),
      worstP99Ms: Math.max(...group.map((item) => item.p99Ms)),
    }),
  );
  ranked.sort(
    (left, right) =>
      left.aggregateErrorRateBps - right.aggregateErrorRateBps ||
      left.worstP95Ms - right.worstP95Ms ||
      left.worstP99Ms - right.worstP99Ms ||
      left.region.localeCompare(right.region),
  );
  return Object.freeze(ranked);
}
