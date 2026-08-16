export type LatencyMilestone =
  | "PROVIDER_RECEIVE"
  | "DECODE_COMPLETE"
  | "IDENTITY_FROZEN"
  | "ETH_CALL_START"
  | "ETH_CALL_END"
  | "SIGN_START"
  | "SIGN_END"
  | "FIRST_WIRE_START"
  | "FIRST_WIRE_RESPONSE"
  | "RECEIPT_FIRST_SEEN"
  | "EFFECT_RECONCILED";

export interface LatencyPoint {
  readonly traceId: string;
  readonly providerId: string;
  readonly region: string;
  readonly profileId: string;
  readonly milestone: LatencyMilestone;
  readonly monotonicMs: number;
}

export interface LatencySummary {
  readonly providerId: string;
  readonly region: string;
  readonly profileId: string;
  readonly segment: string;
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) throw new RangeError("cannot calculate an empty percentile");
  const rank = Math.ceil(quantile * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(rank, sorted.length - 1))] as number;
}

export class LatencyTimeline {
  readonly #points: LatencyPoint[] = [];

  record(point: LatencyPoint): void {
    if (!Number.isFinite(point.monotonicMs) || point.monotonicMs < 0) {
      throw new RangeError("monotonicMs must be a non-negative finite number");
    }
    const existing = this.#points.find(
      (entry) => entry.traceId === point.traceId && entry.milestone === point.milestone,
    );
    if (existing !== undefined) throw new Error(`duplicate milestone ${point.milestone}`);
    this.#points.push(Object.freeze({ ...point }));
  }

  duration(traceId: string, from: LatencyMilestone, to: LatencyMilestone): number | null {
    const start = this.#points.find(
      (point) => point.traceId === traceId && point.milestone === from,
    );
    const end = this.#points.find((point) => point.traceId === traceId && point.milestone === to);
    if (start === undefined || end === undefined) return null;
    if (end.monotonicMs < start.monotonicMs) throw new Error("latency milestone order is invalid");
    return end.monotonicMs - start.monotonicMs;
  }

  summarize(from: LatencyMilestone, to: LatencyMilestone): readonly LatencySummary[] {
    const grouped = new Map<string, { meta: LatencyPoint; durations: number[] }>();
    for (const start of this.#points.filter((point) => point.milestone === from)) {
      const duration = this.duration(start.traceId, from, to);
      if (duration === null) continue;
      const key = `${start.providerId}\u0000${start.region}\u0000${start.profileId}`;
      const group = grouped.get(key) ?? { meta: start, durations: [] };
      group.durations.push(duration);
      grouped.set(key, group);
    }
    return Object.freeze(
      [...grouped.values()].map(({ meta, durations }) => {
        const sorted = [...durations].sort((left, right) => left - right);
        return Object.freeze({
          providerId: meta.providerId,
          region: meta.region,
          profileId: meta.profileId,
          segment: `${from}->${to}`,
          count: sorted.length,
          p50Ms: percentile(sorted, 0.5),
          p95Ms: percentile(sorted, 0.95),
          p99Ms: percentile(sorted, 0.99),
        });
      }),
    );
  }
}
