# Provider and region benchmark runbook

## Goal

Choose deployment region from measured evidence, not geographic intuition. Measure every candidate under comparable network conditions and retain raw samples plus the summary.

## Metrics

- WSS new-head delivery latency and reconnect/gap rate;
- exact launch-topic log delivery latency;
- historical exact-block `eth_call` latency and error rate;
- sequencer endpoint response to a deterministic invalid raw transaction;
- ordinary RPC response to the same deterministic invalid raw transaction.

The invalid payload must be guaranteed non-executable and contain no valid signature. An expected deterministic rejection counts as a successful transport probe when the probe adapter validates the expected error; a timeout or unexpected response counts as failure.

## Method

1. Use at least two candidate regions and the same provider set, sample count, time window, and host class.
2. Record region, provider ID, metric, monotonic latency, success/failure, UTC observation time, and network-condition label for every sample.
3. Run warm-up samples separately; do not mix them into the scored set.
4. Summarize p50/p95/p99, jitter, and error rate. Rank reliability before p95/p99 latency.
5. Repeat in at least two time windows. A single short run is provisional.
6. Save raw NDJSON/JSON outside the public repository if it contains provider identifiers or credential-bearing endpoints; publish only redacted aggregate evidence.

## Selection and retest

Select the primary region only when it has acceptable error rate across all critical metrics; lower median latency cannot compensate for missing logs or inconsistent exact-block reads. Retest after provider/endpoint changes, chain upgrades, host changes, or material latency drift.

`src/ops/region-benchmark.ts` provides reproducible collection, percentile summaries, and ranking. It does not create cloud hosts or prove any present region is fastest.
