import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectBenchmarkSamples,
  rankRegions,
  summarizeBenchmark,
  type BenchmarkProbe,
  type BenchmarkSample,
} from "../src/ops/region-benchmark.js";

describe("reproducible provider/region benchmark", () => {
  it("collects success/failure latency without sending a valid transaction", async () => {
    let clock = 0;
    const probes: BenchmarkProbe[] = [
      {
        region: "region-a",
        providerId: "rpc-a",
        metric: "ETH_CALL",
        networkCondition: "wired",
        run: async () => undefined,
      },
      {
        region: "region-a",
        providerId: "sequencer",
        metric: "SEQUENCER_INVALID_RAW",
        networkCondition: "wired",
        run: async () => Promise.reject(new Error("typed transaction too short")),
      },
    ];
    const samples = await collectBenchmarkSamples({
      probes,
      iterations: 2,
      now: () => (clock += 5),
      isoNow: () => "2026-08-16T00:00:00Z",
    });
    assert.equal(samples.length, 4);
    assert.equal(samples.filter((sample) => sample.success).length, 2);
    assert.ok(samples.every((sample) => sample.latencyMs === 5));
  });

  it("reports errors, p50/p95/p99/jitter and ranks reliability before latency", () => {
    const samples: BenchmarkSample[] = [];
    for (const [region, base, failAt] of [
      ["reliable", 20, -1],
      ["fast-flaky", 5, 9],
    ] as const) {
      for (let index = 0; index < 10; index += 1) {
        samples.push({
          region,
          providerId: `${region}-rpc`,
          metric: "ETH_CALL",
          success: index !== failAt,
          latencyMs: base + index,
          observedAt: `2026-08-16T00:00:${String(index).padStart(2, "0")}Z`,
          networkCondition: "controlled-fixture",
        });
      }
    }
    const summaries = summarizeBenchmark(samples);
    const reliable = summaries.find((summary) => summary.region === "reliable");
    assert.equal(reliable?.p50Ms, 24);
    assert.equal(reliable?.p95Ms, 29);
    assert.equal(reliable?.p99Ms, 29);
    assert.equal(reliable?.jitterMs, 9);
    assert.equal(rankRegions(summaries)[0]?.region, "reliable");
  });
});
