import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Server } from "node:http";
import { AsyncAlertDispatcher, type AlertEvent, type AlertTransport } from "../src/ops/alerts.js";
import {
  laneSemanticState,
  renderOpsDashboard,
  type DashboardModel,
} from "../src/ops/dashboard.js";
import { acquireDeploymentRole } from "../src/ops/failover.js";
import { createOpsServer } from "../src/ops/http-server.js";
import {
  evaluateOperationalReadiness,
  type OperationalReadinessInput,
} from "../src/ops/readiness.js";
import { SqliteStore } from "../src/persistence/sqlite-store.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

function readinessInput(
  overrides: Partial<OperationalReadinessInput> = {},
): OperationalReadinessInput {
  return {
    chain: {
      connected: true,
      observedChainId: 4_663,
      expectedChainId: 4_663,
      latestBlock: "100",
      lagBlocks: 0,
    },
    transport: {
      rpcHttpReady: true,
      rpcWssReady: true,
      sequencerReady: true,
      providerIds: ["primary", "sequencer"],
    },
    factory: { state: "HOT_ARMED", profileId: "factory-v1", profileRevision: 1 },
    wallets: { expected: 10, signerReady: 10, nonceReady: 10, fundingReady: 10 },
    priceSnapshot: { state: "FRESH", snapshotId: "price-1", expiresAt: "2026-08-16T00:01:00Z" },
    database: { walEnabled: true, leaseOwned: true, schemaVersion: 3 },
    identity: { level: "L3", caState: "PENDING" },
    strategy: { entryEnabled: true, exitEnabled: true, entryState: "ARMED", exitState: "WATCHING" },
    exposure: { unknownAttemptCount: 0, openPositionCount: 0, verifiedExitRouteCount: 0 },
    ...overrides,
  };
}

function dashboard(): DashboardModel {
  return {
    title: "CLOCKIN EVIDENCE BOARD",
    phase: "ARMED",
    latestBlock: "123456",
    lagBlocks: 0,
    factory: { candidateCount: 2, profileId: "factory-v1", revision: 3, state: "HOT_ARMED" },
    identity: {
      token: `0x${"11".repeat(20)}`,
      pool: `0x${"22".repeat(20)}`,
      creator: `0x${"33".repeat(20)}`,
      caState: "PENDING",
    },
    mechanism: { declaredFeeBps: 4_000, effectiveDragBps: 4_100, capRaw: "5000", inWindow: true },
    lanes: [
      {
        laneId: "lane-1",
        walletLabel: "wallet-01",
        targetFeeBps: 4_000,
        observedFeeBps: 4_000,
        transportState: "ACCEPTED",
        principalRaw: "5000",
        signed: true,
      },
    ],
    position: {
      principalRaw: "0",
      gasRaw: "0",
      tokenRemainingRaw: "0",
      recoveredPrincipalRaw: "0",
      runnerState: "NOT_STARTED",
    },
    routes: [],
    recentEvents: [{ time: "00:00:00", kind: "INFO", message: "waiting for canonical receipt" }],
  };
}

describe("health, readiness and evidence-only dashboard", () => {
  it("makes HOT_ARMED depend on every P0 readiness input with concrete reasons", () => {
    assert.equal(evaluateOperationalReadiness(readinessInput()).hotArmed, true);
    const notReady = evaluateOperationalReadiness(
      readinessInput({
        transport: {
          rpcHttpReady: true,
          rpcWssReady: false,
          sequencerReady: false,
          providerIds: ["primary"],
        },
        wallets: { expected: 10, signerReady: 10, nonceReady: 9, fundingReady: 8 },
        priceSnapshot: { state: "STALE" },
      }),
    );
    assert.equal(notReady.hotArmed, false);
    assert.ok(notReady.reasons.some((reason) => reason.includes("WSS")));
    assert.ok(notReady.reasons.some((reason) => reason.includes("funded")));
    assert.ok(notReady.reasons.some((reason) => reason.includes("price snapshot")));
  });

  it("serves liveness separately from readiness on localhost and never exposes secrets", async () => {
    const notReady = evaluateOperationalReadiness(
      readinessInput({ factory: { state: "OBSERVED" } }),
    );
    const ops = createOpsServer(
      { readiness: () => notReady, dashboard },
      { host: "127.0.0.1", port: 0 },
    );
    servers.push(ops.server);
    await new Promise<void>((resolve) => ops.server.listen(0, ops.host, resolve));
    const address = ops.server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no port");
    const base = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "alive" });
    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 503);
    const body = await ready.text();
    assert.equal(/private.?key|raw.?transaction|chainstack\.com\//iu.test(body), false);
    const board = await fetch(`${base}/dashboard`);
    assert.equal(board.status, 200);
    assert.match(board.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  });

  it("renders accepted/known/unknown as BROADCAST, never as a successful position", () => {
    const model = dashboard();
    const lane = model.lanes[0];
    if (lane === undefined) throw new Error("fixture lane missing");
    assert.equal(laneSemanticState(lane), "BROADCAST");
    const html = renderOpsDashboard(model);
    assert.match(html, /BROADCAST/);
    assert.match(html, /不代表成交/);
    assert.doesNotMatch(html, /成交成功/);
  });
});

describe("asynchronous redacted alerts", () => {
  const event: AlertEvent = {
    kind: "UNKNOWN_ATTEMPT",
    severity: "CRITICAL",
    strategyId: "clockin",
    launchId: "launch-1",
    objectId: "attempt-1",
    message: "transport is unknown",
    fields: {
      txHash: `0x${"11".repeat(32)}`,
      tokenAddress: `0x${"22".repeat(20)}`,
      privateKey: `0x${"33".repeat(32)}`,
      rawTransaction: "0x010203",
      rpcUrl: "https://provider.example/secret-token",
    },
    observedAt: "2026-08-16T00:00:00Z",
  };

  it("returns without awaiting notification I/O and redacts credentials/raw payloads", async () => {
    const delivered: AlertEvent[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport: AlertTransport = {
      transportId: "slow",
      async send(safe) {
        delivered.push(safe);
        await gate;
      },
    };
    const dispatcher = new AsyncAlertDispatcher([transport]);
    dispatcher.publish(event);
    assert.equal(delivered.length, 0);
    await Promise.resolve();
    assert.equal(delivered[0]?.fields.privateKey, "[REDACTED]");
    assert.equal(delivered[0]?.fields.rawTransaction, "[REDACTED]");
    assert.equal(delivered[0]?.fields.rpcUrl, "[REDACTED]");
    assert.equal(delivered[0]?.fields.tokenAddress, event.fields.tokenAddress);
    release?.();
    await dispatcher.flush();
  });

  it("contains transport failures without rejecting the hot path", async () => {
    const dispatcher = new AsyncAlertDispatcher([
      { transportId: "broken", send: async () => Promise.reject(new Error("offline")) },
    ]);
    assert.doesNotThrow(() => dispatcher.publish(event));
    await dispatcher.flush();
    assert.deepEqual(dispatcher.failures, [{ transportId: "broken", message: "offline" }]);
  });
});

describe("single-writer active/observer failover", () => {
  it("keeps observers keyless and prevents concurrent active writer leases", () => {
    const store = new SqliteStore(":memory:");
    try {
      const observer = acquireDeploymentRole({
        store,
        role: "OBSERVER",
        ownerId: "observer-a",
        hasSignerCredentials: false,
        leaseExpiresAt: "2026-08-16T00:10:00Z",
        now: "2026-08-16T00:00:00Z",
      });
      assert.equal(observer.signingAllowed, false);
      const active = acquireDeploymentRole({
        store,
        role: "ACTIVE_EXECUTOR",
        ownerId: "active-a",
        hasSignerCredentials: true,
        leaseExpiresAt: "2026-08-16T00:10:00Z",
        now: "2026-08-16T00:00:00Z",
      });
      assert.equal(active.signingAllowed, true);
      assert.throws(
        () =>
          acquireDeploymentRole({
            store,
            role: "ACTIVE_EXECUTOR",
            ownerId: "active-b",
            hasSignerCredentials: true,
            leaseExpiresAt: "2026-08-16T00:10:00Z",
            now: "2026-08-16T00:01:00Z",
          }),
        /leased/,
      );
      assert.throws(
        () =>
          acquireDeploymentRole({
            store,
            role: "OBSERVER",
            ownerId: "observer-with-key",
            hasSignerCredentials: true,
            leaseExpiresAt: "2026-08-16T00:10:00Z",
            now: "2026-08-16T00:00:00Z",
          }),
        /must not/,
      );
    } finally {
      store.close();
    }
  });

  it("allows controlled takeover after lease expiry but blocks new entry on UNKNOWN/nonces", () => {
    const store = new SqliteStore(":memory:");
    try {
      acquireDeploymentRole({
        store,
        role: "ACTIVE_EXECUTOR",
        ownerId: "old-active",
        hasSignerCredentials: true,
        leaseExpiresAt: "2026-08-16T00:01:00Z",
        now: "2026-08-16T00:00:00Z",
      });
      const takeover = acquireDeploymentRole({
        store,
        role: "ACTIVE_EXECUTOR",
        ownerId: "new-active",
        hasSignerCredentials: true,
        leaseExpiresAt: "2026-08-16T00:10:00Z",
        now: "2026-08-16T00:02:00Z",
        takeoverAudit: {
          unknownAttemptCount: 1,
          walletNonces: [{ walletId: "wallet-1", latestNonce: 7n, pendingNonce: 8n }],
          canonicalDatabaseAvailable: true,
          signedVaultAvailable: true,
        },
      });
      assert.equal(takeover.signingAllowed, true);
      assert.equal(takeover.newEntryAllowed, false);
      assert.ok(takeover.reasons.some((reason) => reason.includes("UNKNOWN")));
      assert.ok(takeover.reasons.some((reason) => reason.includes("nonce")));
    } finally {
      store.close();
    }
  });
});
