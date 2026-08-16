import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createOpsServer } from "./ops/http-server.js";
import type { DashboardModel } from "./ops/dashboard.js";
import {
  evaluateOperationalReadiness,
  type OperationalReadiness,
  type OperationalReadinessInput,
} from "./ops/readiness.js";
import { HttpJsonRpcClient } from "./rpc/http-json-rpc.js";
import type { JsonRpcRequester } from "./rpc/types.js";
import {
  ROBINHOOD_MAINNET_SEQUENCER_URL,
  verifyRobinhoodMainnet,
  verifyRobinhoodSequencerWriteEndpoint,
} from "./rpc/robinhood.js";
import { WebSocketNewHeadsClient, type NewHeadsSubscription } from "./rpc/websocket-new-heads.js";
import { hexToBigInt } from "./rpc/hex.js";
import { freezePriceSnapshot, type PriceObservation } from "./wallets/price-snapshot.js";
import { inspectWalletReadiness, type WalletReadinessReport } from "./wallets/readiness.js";
import type { WalletManifest } from "./wallets/wallet-manifest.js";

const EXPECTED_WALLETS = 10;
const REFRESH_MS = 5_000;
const WEBSITE_REFRESH_MS = 30_000;
const PRICE_MAXIMUM_AGE_MS = 30_000;
const PRICE_MAXIMUM_DEVIATION_BPS = 200;
const USD_MICROS_PER_BATCH = 5_000_000n;
const USD_MICROS_ALL_IN = 60_000_000n;

interface ControlEvent {
  readonly time: string;
  readonly kind: "ERROR" | "ACTION" | "INFO";
  readonly message: string;
}

interface RuntimeState {
  latestBlock: bigint;
  httpReady: boolean;
  wssReady: boolean;
  sequencerReady: boolean;
  walletReport: WalletReadinessReport | null;
  priceSnapshotId: string | null;
  priceExpiresAtMs: number | null;
  lastRefreshAt: string | null;
  websiteHashes: Map<string, string>;
  events: ControlEvent[];
}

class LimitedJsonRpcRequester implements JsonRpcRequester {
  readonly providerId: string;
  readonly #inner: JsonRpcRequester;
  readonly #maximumConcurrency: number;
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(inner: JsonRpcRequester, maximumConcurrency: number) {
    if (!Number.isSafeInteger(maximumConcurrency) || maximumConcurrency < 1) {
      throw new RangeError("maximumConcurrency must be a positive safe integer");
    }
    this.providerId = inner.providerId;
    this.#inner = inner;
    this.#maximumConcurrency = maximumConcurrency;
  }

  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    if (this.#active >= this.#maximumConcurrency) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    this.#active += 1;
    try {
      return await this.#inner.request<T>(method, params);
    } finally {
      this.#active -= 1;
      this.#waiters.shift()?.();
    }
  }
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

async function readCredential(name: string): Promise<string> {
  const directory = process.env.CREDENTIALS_DIRECTORY?.trim();
  if (directory === undefined || directory.length === 0) {
    throw new Error("CREDENTIALS_DIRECTORY is required");
  }
  const value = (await readFile(join(directory, name), "utf8")).trim();
  if (value.length === 0) throw new Error(`credential ${name} is empty`);
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
      rpcWssReady: state.wssReady,
      sequencerReady: state.sequencerReady,
      providerIds: Object.freeze(["production-http", "production-wss", "official-sequencer"]),
    }),
    factory: Object.freeze({ state: "UNKNOWN" as const }),
    wallets: Object.freeze({
      expected: EXPECTED_WALLETS,
      signerReady: 0,
      nonceReady: walletReport?.nonceCleanWallets ?? 0,
      fundingReady: walletReport?.readyWallets ?? 0,
    }),
    priceSnapshot,
    database: Object.freeze({ walEnabled: false, leaseOwned: false, schemaVersion: 0 }),
    identity: Object.freeze({ level: "L0" as const, caState: "UNKNOWN" as const }),
    strategy: Object.freeze({
      entryEnabled: false,
      exitEnabled: false,
      entryState: "FAIL_CLOSED_AWAITING_FINAL_PROFILE",
      exitState: "NO_VERIFIED_MAINNET_ROUTE",
    }),
    exposure: Object.freeze({
      unknownAttemptCount: 0,
      openPositionCount: 0,
      verifiedExitRouteCount: 0,
    }),
  });
}

function dashboard(state: RuntimeState): DashboardModel {
  const rows = state.walletReport?.rows ?? [];
  return Object.freeze({
    title: "ClockIn Production Sentinel",
    phase: "WATCHING / NOT_HOT_ARMED",
    latestBlock: state.latestBlock.toString(),
    lagBlocks: 0,
    factory: Object.freeze({
      candidateCount: 0,
      profileId: "UNPUBLISHED",
      revision: 0,
      state: "UNKNOWN",
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
          targetFeeBps: 0,
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
      runnerState: "NO_POSITION",
    }),
    routes: Object.freeze([]),
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
    websiteHashes: Object.fromEntries(state.websiteHashes),
    lastRefreshAt: state.lastRefreshAt,
  };
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}

async function monitorWebsite(state: RuntimeState): Promise<void> {
  for (const url of [
    "https://www.stonkbrokers.cash/launcher",
    "https://www.stonkbrokers.cash/safe-launch",
  ]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      const current = createHash("sha256").update(body).digest("hex");
      const previous = state.websiteHashes.get(url);
      state.websiteHashes.set(url, current);
      if (previous !== undefined && previous !== current) {
        recordEvent(
          state,
          "ACTION",
          `official website fingerprint changed: ${new URL(url).pathname}`,
        );
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
  const manifestPath = process.env.CLOCKIN_MANIFEST_PATH?.trim();
  if (manifestPath === undefined || manifestPath.length === 0) {
    throw new Error("CLOCKIN_MANIFEST_PATH is required");
  }
  const [rpcHttp, rpcWss, manifestRaw] = await Promise.all([
    readCredential("rpc_http"),
    readCredential("rpc_wss"),
    readFile(manifestPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestRaw) as WalletManifest;
  if (manifest.entries.length !== EXPECTED_WALLETS) {
    throw new Error(`wallet manifest must contain exactly ${EXPECTED_WALLETS} entries`);
  }

  const stateDirectory = process.env.CLOCKIN_STATE_DIR?.trim() || "/var/lib/clockin-sniper";
  const host = process.env.CLOCKIN_OPS_HOST?.trim() || "127.0.0.1";
  const port = integerEnv("CLOCKIN_OPS_PORT", 8_787);
  const http = new LimitedJsonRpcRequester(
    new HttpJsonRpcClient({
      providerId: "production-http",
      url: rpcHttp,
      timeoutMs: 8_000,
    }),
    4,
  );
  const sequencer = new HttpJsonRpcClient({
    providerId: "official-sequencer",
    url: ROBINHOOD_MAINNET_SEQUENCER_URL,
    timeoutMs: 4_000,
  });
  const wss = new WebSocketNewHeadsClient({
    providerId: "production-wss",
    url: rpcWss,
    setupTimeoutMs: 8_000,
  });
  const state: RuntimeState = {
    latestBlock: 0n,
    httpReady: false,
    wssReady: false,
    sequencerReady: false,
    walletReport: null,
    priceSnapshotId: null,
    priceExpiresAtMs: null,
    lastRefreshAt: null,
    websiteHashes: new Map(),
    events: [],
  };
  let subscription: NewHeadsSubscription | null = null;
  let refreshRunning = false;
  let stopping = false;

  const refresh = async (): Promise<void> => {
    if (refreshRunning || stopping) return;
    refreshRunning = true;
    try {
      const nowMs = Date.now();
      const [identity, gasPriceHex, priceSnapshot] = await Promise.all([
        verifyRobinhoodMainnet(http),
        http.request<string>("eth_gasPrice"),
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
      state.latestBlock = identity.blockNumber;
      state.httpReady = true;
      state.priceSnapshotId = priceSnapshot.snapshotId;
      state.priceExpiresAtMs = priceSnapshot.expiresAtMs;
      const gasPriceWei = hexToBigInt("eth_gasPrice", gasPriceHex);
      const boundedMaxFeeWei = gasPriceWei * 5n;
      const aggregateAllInCapWei =
        (USD_MICROS_ALL_IN * 1_000_000_000_000_000_000n) / priceSnapshot.primary.usdMicrosPerEth;
      state.walletReport = await inspectWalletReadiness(http, manifest, {
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
      state.httpReady = false;
      state.priceSnapshotId = null;
      state.priceExpiresAtMs = null;
      recordEvent(
        state,
        "ERROR",
        `readiness refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const currentReadiness = evaluateOperationalReadiness(readinessInput(state));
      await writeSnapshot(stateDirectory, currentReadiness, state);
    } finally {
      refreshRunning = false;
    }
  };

  try {
    await verifyRobinhoodSequencerWriteEndpoint(sequencer);
    state.sequencerReady = true;
  } catch (error) {
    recordEvent(
      state,
      "ERROR",
      `sequencer probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const connectWss = async (): Promise<void> => {
    while (!stopping) {
      try {
        subscription = await wss.subscribe((head) => {
          state.latestBlock = head.blockNumber;
          void refresh();
        });
        state.wssReady = true;
        recordEvent(state, "INFO", "production WSS newHeads subscribed");
        await subscription.done;
      } catch (error) {
        if (!stopping) {
          recordEvent(
            state,
            "ERROR",
            `WSS disconnected: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } finally {
        state.wssReady = false;
        subscription = null;
      }
      if (!stopping) await new Promise((resolve) => setTimeout(resolve, 2_000));
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

  await refresh();
  await monitorWebsite(state);
  const refreshTimer = setInterval(() => void refresh(), REFRESH_MS);
  const websiteTimer = setInterval(() => void monitorWebsite(state), WEBSITE_REFRESH_MS);
  void connectWss();

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    recordEvent(state, "INFO", `shutdown requested by ${signal}`);
    clearInterval(refreshTimer);
    clearInterval(websiteTimer);
    subscription?.close();
    await new Promise<void>((resolve) => ops.server.close(() => resolve()));
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
