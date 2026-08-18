import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import {
  compareOfficialSiteObservations,
  observeOfficialSite,
  type OfficialSiteObservation,
} from "./control/official-site-monitor.js";
import { createOpsServer } from "./ops/http-server.js";
import type { DashboardModel } from "./ops/dashboard.js";
import {
  evaluateOperationalReadiness,
  type OperationalReadiness,
  type OperationalReadinessInput,
} from "./ops/readiness.js";
import { verifyRobinhoodMainnet } from "./rpc/robinhood.js";
import { hexToBigInt } from "./rpc/hex.js";
import { PublicControlRpc } from "./runtime/public-control-rpc.js";
import type { JsonRpcRequester } from "./rpc/types.js";
import {
  readProductionServiceStatus,
  writeProductionServiceStatus,
  type ProductionServiceReadback,
} from "./runtime/service-status.js";
import { SystemdWatchdog } from "./runtime/systemd-watchdog.js";
import { freezePriceSnapshot, type PriceObservation } from "./wallets/price-snapshot.js";
import { inspectWalletReadiness, type WalletReadinessReport } from "./wallets/readiness.js";
import type { WalletManifest } from "./wallets/wallet-manifest.js";

const EXPECTED_WALLETS = 10;
const STATUS_REFRESH_MS = 5_000;
const WEBSITE_REFRESH_MS = 30_000;
const DEFAULT_HEAD_POLL_MS = 2_000;
const DEFAULT_IDENTITY_REFRESH_MS = 300_000;
const DEFAULT_WALLET_REFRESH_MS = 3_600_000;
const PRICE_MAXIMUM_AGE_MS = 30_000;
const PRICE_MAXIMUM_DEVIATION_BPS = 200;
const USD_MICROS_PER_BATCH = 5_000_000n;
const USD_MICROS_ALL_IN = 60_000_000n;
const STATUS_MAXIMUM_AGE_MS = 15_000;

interface ControlEvent {
  readonly time: string;
  readonly kind: "ERROR" | "ACTION" | "INFO";
  readonly message: string;
}

interface RuntimeState {
  latestBlock: bigint;
  httpReady: boolean;
  walletReport: WalletReadinessReport | null;
  priceSnapshotId: string | null;
  priceExpiresAtMs: number | null;
  lastRefreshAt: string | null;
  lastHeadPollAt: string | null;
  lastIdentityCheckAt: string | null;
  websiteObservations: Map<string, OfficialSiteObservation>;
  serviceReadbacks: Map<"executor" | "reconciler" | "exit", ProductionServiceReadback>;
  events: ControlEvent[];
  publicRpc: PublicControlRpc;
  headPollMs: number;
  identityRefreshMs: number;
  walletRefreshMs: number;
}

function integerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function boundedIntervalEnv(name: string, fallback: number, minimum: number): number {
  const value = integerEnv(name, fallback);
  if (value < minimum) throw new RangeError(`${name} must be at least ${minimum}ms`);
  return value;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function positivePriceMicros(sourceId: string, price: unknown): bigint {
  const numeric = typeof price === "string" ? Number(price) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`${sourceId} returned an invalid ETH/USD price`);
  }
  return BigInt(Math.round(numeric * 1_000_000));
}

async function coinbasePrice(nowMs: number): Promise<PriceObservation> {
  const payload = (await fetchJson("https://api.coinbase.com/v2/prices/ETH-USD/spot")) as {
    readonly data?: { readonly amount?: unknown };
  };
  return Object.freeze({
    sourceId: "coinbase-spot",
    usdMicrosPerEth: positivePriceMicros("coinbase-spot", payload.data?.amount),
    observedAtMs: nowMs,
    evidenceId: `coinbase-spot:${nowMs}`,
  });
}

async function krakenPrice(nowMs: number): Promise<PriceObservation> {
  const payload = (await fetchJson("https://api.kraken.com/0/public/Ticker?pair=ETHUSD")) as {
    readonly result?: Readonly<Record<string, { readonly c?: readonly unknown[] }>>;
  };
  const ticker = Object.values(payload.result ?? {})[0];
  return Object.freeze({
    sourceId: "kraken-ticker",
    usdMicrosPerEth: positivePriceMicros("kraken-ticker", ticker?.c?.[0]),
    observedAtMs: nowMs,
    evidenceId: `kraken-ticker:${nowMs}`,
  });
}

function recordEvent(state: RuntimeState, kind: ControlEvent["kind"], message: string): void {
  state.events.unshift(Object.freeze({ time: new Date().toISOString(), kind, message }));
  state.events.splice(25);
  process.stdout.write(`${JSON.stringify({ service: "clockin-control", kind, message })}\n`);
}

function readinessInput(state: RuntimeState): OperationalReadinessInput {
  const walletReport = state.walletReport;
  const executorReadback = state.serviceReadbacks.get("executor");
  const reconcilerReadback = state.serviceReadbacks.get("reconciler");
  const exitReadback = state.serviceReadbacks.get("exit");
  const executor = executorReadback?.state === "CURRENT" ? executorReadback.status : null;
  const reconciler = reconcilerReadback?.state === "CURRENT" ? reconcilerReadback.status : null;
  const exit = exitReadback?.state === "CURRENT" ? exitReadback.status : null;
  const chain = state.httpReady
    ? Object.freeze({
        connected: true,
        observedChainId: 4_663,
        expectedChainId: 4_663,
        latestBlock: state.latestBlock.toString(),
        lagBlocks: 0,
      })
    : Object.freeze({
        connected: false,
        expectedChainId: 4_663,
        latestBlock: state.latestBlock.toString(),
        lagBlocks: 0,
      });
  const snapshotId = state.priceSnapshotId;
  const expiresAtMs = state.priceExpiresAtMs;
  const priceFresh = snapshotId !== null && expiresAtMs !== null && expiresAtMs >= Date.now();
  const priceSnapshot = priceFresh
    ? Object.freeze({
        state: "FRESH" as const,
        snapshotId,
        expiresAt: new Date(expiresAtMs).toISOString(),
      })
    : Object.freeze({ state: "MISSING" as const });
  return Object.freeze({
    chain,
    transport: Object.freeze({
      rpcHttpReady: state.httpReady,
      rpcWssReady: false,
      sequencerReady: false,
      providerIds: Object.freeze([state.publicRpc.providerId]),
    }),
    factory:
      executor !== null &&
      executor.profileId !== undefined &&
      executor.profileRevision !== undefined &&
      executor.profileRevision > 0 &&
      ["WATCHING", "READY", "ACTIVE"].includes(executor.state)
        ? Object.freeze({
            state: "HOT_ARMED" as const,
            profileId: executor.profileId,
            profileRevision: executor.profileRevision,
          })
        : Object.freeze({ state: "UNKNOWN" as const }),
    wallets: Object.freeze({
      expected: EXPECTED_WALLETS,
      signerReady: executor?.signerReady ?? 0,
      nonceReady: walletReport?.nonceCleanWallets ?? 0,
      fundingReady: walletReport?.readyWallets ?? 0,
    }),
    priceSnapshot,
    database: Object.freeze({
      walEnabled: executor?.database.walEnabled ?? false,
      leaseOwned: executor?.database.leaseOwned ?? false,
      schemaVersion: executor?.database.schemaVersion ?? 0,
    }),
    identity: Object.freeze({ level: "L0" as const, caState: "UNKNOWN" as const }),
    strategy: Object.freeze({
      entryEnabled: executor?.entryEnabled ?? false,
      exitEnabled: (exit?.exitEnabled ?? false) && reconciler !== null,
      entryState:
        executor === null ? "FAIL_CLOSED_AWAITING_EXECUTOR" : `${executor.state}_EXECUTOR`,
      exitState:
        exit === null
          ? "NO_CURRENT_EXIT_SERVICE"
          : reconciler === null
            ? "NO_CURRENT_RECONCILER"
            : `${exit.state}_EXIT_${reconciler.state}_RECONCILER`,
    }),
    exposure: Object.freeze({
      unknownAttemptCount: Math.max(
        executor?.unresolvedAttemptCount ?? 0,
        reconciler?.unresolvedAttemptCount ?? 0,
        exit?.unresolvedAttemptCount ?? 0,
      ),
      openPositionCount: Math.max(
        executor?.openPositionCount ?? 0,
        reconciler?.openPositionCount ?? 0,
        exit?.openPositionCount ?? 0,
      ),
      verifiedExitRouteCount: exit?.verifiedExitRouteCount ?? 0,
    }),
  });
}

function dashboard(state: RuntimeState): DashboardModel {
  const rows = state.walletReport?.rows ?? [];
  const websiteCandidateCount = new Set(
    [...state.websiteObservations.values()].flatMap((observation) => [
      ...observation.candidateAddresses,
    ]),
  ).size;
  const readiness = evaluateOperationalReadiness(readinessInput(state));
  const executorReadback = state.serviceReadbacks.get("executor");
  const exitReadback = state.serviceReadbacks.get("exit");
  const executor = executorReadback?.state === "CURRENT" ? executorReadback.status : null;
  const exit = exitReadback?.state === "CURRENT" ? exitReadback.status : null;
  return Object.freeze({
    title: "ClockIn Production Sentinel",
    phase: readiness.hotArmed
      ? "HOT_ARMED / WAITING_FACTORY_EVENT"
      : "PUBLIC_MONITORING / NOT_HOT_ARMED",
    latestBlock: state.latestBlock.toString(),
    lagBlocks: 0,
    factory: Object.freeze({
      candidateCount: websiteCandidateCount,
      profileId: executor?.profileId ?? "UNPUBLISHED",
      revision: executor?.profileRevision ?? 0,
      state: readiness.snapshot.factory.state,
    }),
    identity: Object.freeze({
      token: "UNKNOWN",
      pool: "UNKNOWN",
      creator: "UNKNOWN",
      caState: "UNKNOWN",
    }),
    mechanism: Object.freeze({ capRaw: "UNKNOWN", inWindow: false }),
    lanes: Object.freeze(
      Array.from({ length: EXPECTED_WALLETS }, (_, index) => {
        const row = rows[index];
        return Object.freeze({
          laneId: String(index + 1),
          walletLabel: row?.walletId ?? `entry-${String(index + 1).padStart(2, "0")}`,
          targetFeeBps: Math.round(4_000 - (4_000 * index) / (EXPECTED_WALLETS - 1)),
          principalRaw: row?.balanceWei.toString() ?? "0",
          signed: false,
        });
      }),
    ),
    position: Object.freeze({
      principalRaw: "0",
      gasRaw: "0",
      tokenRemainingRaw: "0",
      recoveredPrincipalRaw: "0",
      runnerState:
        (exit?.openPositionCount ?? 0) > 0
          ? `${exit?.state ?? "UNKNOWN"}_EXIT_POLICY`
          : "NO_POSITION",
    }),
    routes: Object.freeze(
      Array.from({ length: exit?.verifiedExitRouteCount ?? 0 }, (_, index) =>
        Object.freeze({
          routeId: `verified-route-${index + 1}`,
          kind: "PROFILE_BOUND",
          netOutputRaw: "AWAITING_POSITION_QUOTE",
          state: exit?.state ?? "UNKNOWN",
        }),
      ),
    ),
    recentEvents: Object.freeze([...state.events]),
  });
}

async function writeSnapshot(
  stateDirectory: string,
  readiness: OperationalReadiness,
  state: RuntimeState,
): Promise<void> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700);
  const target = join(stateDirectory, "control-snapshot.json");
  const temporary = join(stateDirectory, `.control-snapshot.${process.pid}.tmp`);
  const payload = {
    generatedAt: new Date().toISOString(),
    readiness,
    walletSummary:
      state.walletReport === null
        ? null
        : {
            readyWallets: state.walletReport.readyWallets,
            nonceCleanWallets: state.walletReport.nonceCleanWallets,
            aggregateRequiredWei: state.walletReport.aggregateRequiredWei.toString(),
            aggregateAllInCapWei: state.walletReport.aggregateAllInCapWei.toString(),
            allInCapReady: state.walletReport.allInCapReady,
            wallets: state.walletReport.rows.map((row) => ({
              walletId: row.walletId,
              address: row.address,
              balanceWei: row.balanceWei.toString(),
              latestNonce: row.latestNonce.toString(),
              pendingNonce: row.pendingNonce.toString(),
              ready: row.ready,
            })),
          },
    websiteHashes: Object.fromEntries(
      [...state.websiteObservations].map(([url, observation]) => [url, observation.rawHash]),
    ),
    websiteSignals: Object.fromEntries(
      [...state.websiteObservations].map(([url, observation]) => [
        url,
        {
          semanticHash: observation.semanticHash,
          launchStatus: observation.launchStatus,
          statusMarkers: observation.statusMarkers,
          candidateAddresses: observation.candidateAddresses,
          clockInMentioned: observation.clockInMentioned,
          robinhoodChainMentioned: observation.robinhoodChainMentioned,
        },
      ]),
    ),
    lastRefreshAt: state.lastRefreshAt,
    lastHeadPollAt: state.lastHeadPollAt,
    lastIdentityCheckAt: state.lastIdentityCheckAt,
    publicRpc: state.publicRpc.usageSnapshot(),
    monitoringPolicy: {
      mode: "OFFICIAL_PUBLIC_HTTP_ONLY",
      headPollMs: state.headPollMs,
      identityRefreshMs: state.identityRefreshMs,
      walletRefreshMs: state.walletRefreshMs,
      minimumRequestIntervalMs: state.publicRpc.minimumIntervalMs,
      paidRpcCapability: false,
    },
  };
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}

async function monitorWebsite(state: RuntimeState): Promise<void> {
  for (const target of [
    Object.freeze({ url: "https://clockin.win/", scope: "CLOCKIN" as const }),
    Object.freeze({
      url: "https://www.stonkbrokers.cash/launcher",
      scope: "LAUNCHER" as const,
    }),
    Object.freeze({
      url: "https://www.stonkbrokers.cash/safe-launch",
      scope: "SAFE_LAUNCH" as const,
    }),
  ]) {
    const { url, scope } = target;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      const current = observeOfficialSite(body, { scope });
      const previous = state.websiteObservations.get(url);
      state.websiteObservations.set(url, current);
      const page = `${new URL(url).hostname}${new URL(url).pathname}`;
      if (previous === undefined) {
        recordEvent(
          state,
          "INFO",
          `official website semantic baseline: ${page} status=${current.launchStatus} candidates=${current.candidateAddresses.length}`,
        );
        if (current.candidateAddresses.length > 0) {
          recordEvent(
            state,
            "ACTION",
            `official website exposes ${current.candidateAddresses.length} unverified candidate address(es): ${page}`,
          );
        }
        if (current.launchStatus === "OPEN") {
          recordEvent(state, "ACTION", `official website launch status is OPEN: ${page}`);
        }
        continue;
      }
      const change = compareOfficialSiteObservations(previous, current);
      if (change.addressSetChanged) {
        recordEvent(
          state,
          "ACTION",
          `official website unverified candidate address set changed: ${page} added=${change.addedAddresses.length} removed=${change.removedAddresses.length}`,
        );
      }
      if (change.statusChanged) {
        recordEvent(
          state,
          "ACTION",
          `official website launch status changed: ${page} ${previous.launchStatus}->${current.launchStatus}`,
        );
      } else if (change.semanticChanged && !change.addressSetChanged) {
        recordEvent(state, "INFO", `official website semantic markers changed: ${page}`);
      }
    } catch (error) {
      recordEvent(
        state,
        "ERROR",
        `official website check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

async function main(): Promise<void> {
  const ownerId = process.env.CLOCKIN_CONTROL_ID?.trim() || `clockin-control:${hostname()}`;
  const watchdog = new SystemdWatchdog();
  const statusDirectory = process.env.CLOCKIN_STATUS_DIR?.trim() || "/run/clockin-status";
  let statusSequence = 0;
  const manifestPath = process.env.CLOCKIN_MANIFEST_PATH?.trim();
  if (manifestPath === undefined || manifestPath.length === 0) {
    throw new Error("CLOCKIN_MANIFEST_PATH is required");
  }
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw) as WalletManifest;
  if (manifest.entries.length !== EXPECTED_WALLETS) {
    throw new Error(`wallet manifest must contain exactly ${EXPECTED_WALLETS} entries`);
  }

  const stateDirectory = process.env.CLOCKIN_STATE_DIR?.trim() || "/var/lib/clockin-sniper";
  const host = process.env.CLOCKIN_OPS_HOST?.trim() || "127.0.0.1";
  const port = integerEnv("CLOCKIN_OPS_PORT", 8_787);
  const headPollMs = boundedIntervalEnv("CLOCKIN_PUBLIC_HEAD_POLL_MS", DEFAULT_HEAD_POLL_MS, 1_000);
  const identityRefreshMs = boundedIntervalEnv(
    "CLOCKIN_PUBLIC_IDENTITY_REFRESH_MS",
    DEFAULT_IDENTITY_REFRESH_MS,
    60_000,
  );
  const walletRefreshMs = boundedIntervalEnv(
    "CLOCKIN_PUBLIC_WALLET_REFRESH_MS",
    DEFAULT_WALLET_REFRESH_MS,
    60_000,
  );
  const publicRpc = new PublicControlRpc({ timeoutMs: 8_000 });
  const http = publicRpc;
  const backgroundHttp: JsonRpcRequester = Object.freeze({
    providerId: publicRpc.providerId,
    request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      return publicRpc.requestBackground<T>(method, params);
    },
  });
  const state: RuntimeState = {
    latestBlock: 0n,
    httpReady: false,
    walletReport: null,
    priceSnapshotId: null,
    priceExpiresAtMs: null,
    lastRefreshAt: null,
    lastHeadPollAt: null,
    lastIdentityCheckAt: null,
    websiteObservations: new Map(),
    serviceReadbacks: new Map(),
    events: [],
    publicRpc,
    headPollMs,
    identityRefreshMs,
    walletRefreshMs,
  };
  let headPollRunning = false;
  let identityCheckRunning = false;
  let walletRefreshRunning = false;
  let publishRunning = false;
  let stopping = false;

  const verifyPublicIdentity = async (): Promise<void> => {
    if (identityCheckRunning || stopping) return;
    identityCheckRunning = true;
    try {
      const identity = await verifyRobinhoodMainnet(http);
      if (state.latestBlock > 0n && identity.blockNumber < state.latestBlock) {
        throw new Error("public RPC head regressed");
      }
      state.latestBlock = identity.blockNumber;
      state.httpReady = true;
      state.lastHeadPollAt = new Date().toISOString();
      state.lastIdentityCheckAt = state.lastHeadPollAt;
    } catch (error) {
      state.httpReady = false;
      recordEvent(
        state,
        "ERROR",
        `public RPC identity check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      identityCheckRunning = false;
    }
  };

  const pollPublicHead = async (): Promise<void> => {
    if (headPollRunning || stopping) return;
    headPollRunning = true;
    try {
      const current = hexToBigInt("eth_blockNumber", await http.request<string>("eth_blockNumber"));
      if (state.latestBlock > 0n && current < state.latestBlock) {
        throw new Error("public RPC head regressed");
      }
      state.latestBlock = current;
      state.httpReady = true;
      state.lastHeadPollAt = new Date().toISOString();
    } catch (error) {
      state.httpReady = false;
      recordEvent(
        state,
        "ERROR",
        `public RPC head poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      headPollRunning = false;
    }
  };

  const refreshWalletReadiness = async (): Promise<void> => {
    if (walletRefreshRunning || stopping) return;
    walletRefreshRunning = true;
    try {
      const nowMs = Date.now();
      const [gasPriceHex, priceSnapshot] = await Promise.all([
        backgroundHttp.request<string>("eth_gasPrice"),
        freezePriceSnapshot(
          () => coinbasePrice(nowMs),
          () => krakenPrice(nowMs),
          {
            nominalUsdMicrosPerBatch: USD_MICROS_PER_BATCH,
            maximumAgeMs: PRICE_MAXIMUM_AGE_MS,
            maximumDeviationBps: PRICE_MAXIMUM_DEVIATION_BPS,
          },
          nowMs,
        ),
      ]);
      state.priceSnapshotId = priceSnapshot.snapshotId;
      state.priceExpiresAtMs = priceSnapshot.expiresAtMs;
      const gasPriceWei = hexToBigInt("eth_gasPrice", gasPriceHex);
      const boundedMaxFeeWei = gasPriceWei * 5n;
      const aggregateAllInCapWei =
        (USD_MICROS_ALL_IN * 1_000_000_000_000_000_000n) / priceSnapshot.primary.usdMicrosPerEth;
      state.walletReport = await inspectWalletReadiness(backgroundHttp, manifest, {
        batchValueWei: priceSnapshot.batchValueWei,
        entryGasLimit: 500_000n,
        entryMaxFeePerGasWei: boundedMaxFeeWei,
        approvalGasLimit: 100_000n,
        sellGasLimit: 800_000n,
        exitMaxFeePerGasWei: boundedMaxFeeWei,
        maximumSellTransactions: 3,
        gasSafetyMarginBps: 3_000,
        aggregateAllInCapWei,
        automaticTopUpAllowed: false,
      });
      state.lastRefreshAt = new Date().toISOString();
    } catch (error) {
      state.priceSnapshotId = null;
      state.priceExpiresAtMs = null;
      recordEvent(
        state,
        "ERROR",
        `public wallet readiness refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      walletRefreshRunning = false;
    }
  };

  const publishStatus = async (): Promise<void> => {
    if (publishRunning || stopping) return;
    publishRunning = true;
    try {
      const peerReadbacks = await Promise.all(
        (["executor", "reconciler", "exit"] as const).map(async (service) =>
          Object.freeze({
            service,
            readback: await readProductionServiceStatus(
              statusDirectory,
              service,
              STATUS_MAXIMUM_AGE_MS,
            ),
          }),
        ),
      );
      for (const peer of peerReadbacks) state.serviceReadbacks.set(peer.service, peer.readback);
      const currentReadiness = evaluateOperationalReadiness(readinessInput(state));
      await writeSnapshot(stateDirectory, currentReadiness, state);
      const executorReadback = state.serviceReadbacks.get("executor");
      const executor = executorReadback?.state === "CURRENT" ? executorReadback.status : undefined;
      statusSequence += 1;
      await writeProductionServiceStatus(statusDirectory, {
        formatVersion: 1,
        service: "control",
        state: currentReadiness.hotArmed ? "READY" : "WATCHING",
        pid: process.pid,
        ownerId,
        sequence: statusSequence,
        observedAt: new Date().toISOString(),
        ...(executor?.profileId === undefined ? {} : { profileId: executor.profileId }),
        ...(executor?.profileRevision === undefined
          ? {}
          : { profileRevision: executor.profileRevision }),
        ...(executor?.profileHash === undefined ? {} : { profileHash: executor.profileHash }),
        signerReady: 0,
        database: Object.freeze({ schemaVersion: 0, walEnabled: false, leaseOwned: false }),
        entryEnabled: false,
        exitEnabled: false,
        unresolvedAttemptCount: currentReadiness.snapshot.exposure.unknownAttemptCount,
        openPositionCount: currentReadiness.snapshot.exposure.openPositionCount,
        verifiedExitRouteCount: currentReadiness.snapshot.exposure.verifiedExitRouteCount,
        details: Object.freeze(
          currentReadiness.hotArmed
            ? ["KEYLESS_CONTROL_HOT_ARMED_READBACK"]
            : ["OFFICIAL_PUBLIC_RPC_ONLY", "PAID_RPC_CAPABILITY_NONE", ...currentReadiness.reasons],
        ),
      });
      await watchdog.status(
        currentReadiness.hotArmed
          ? "control observed HOT_ARMED peers"
          : "control watching fail-closed",
      );
    } finally {
      publishRunning = false;
    }
  };

  const ops = createOpsServer(
    {
      readiness: () => evaluateOperationalReadiness(readinessInput(state)),
      dashboard: () => dashboard(state),
    },
    { host, port },
  );
  await new Promise<void>((resolve, reject) => {
    ops.server.once("error", reject);
    ops.server.listen(port, host, () => resolve());
  });
  recordEvent(state, "INFO", `ops server listening on ${host}:${port}`);

  await verifyPublicIdentity();
  await refreshWalletReadiness();
  await monitorWebsite(state);
  await publishStatus();
  await watchdog.ready("control sentinel ready");
  const headTimer = setInterval(() => void pollPublicHead(), headPollMs);
  const identityTimer = setInterval(() => void verifyPublicIdentity(), identityRefreshMs);
  const walletTimer = setInterval(() => void refreshWalletReadiness(), walletRefreshMs);
  const statusTimer = setInterval(
    () =>
      void publishStatus().catch((error: unknown) =>
        recordEvent(
          state,
          "ERROR",
          `status publication failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ),
    STATUS_REFRESH_MS,
  );
  const websiteTimer = setInterval(() => void monitorWebsite(state), WEBSITE_REFRESH_MS);

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    recordEvent(state, "INFO", `shutdown requested by ${signal}`);
    clearInterval(headTimer);
    clearInterval(identityTimer);
    clearInterval(walletTimer);
    clearInterval(statusTimer);
    clearInterval(websiteTimer);
    await new Promise<void>((resolve) => ops.server.close(() => resolve()));
    await watchdog.stopping(`control stopping after ${signal}`);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      service: "clockin-control",
      state: "FAILED",
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
