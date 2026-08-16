import { CLOCKIN_POLICY_V2 } from "../config/strategy-config.js";
import {
  assertFreshPriceSnapshot,
  freezePriceSnapshot,
  type PriceObservation,
  type PriceSnapshot,
} from "../wallets/price-snapshot.js";

function decimalUsdToMicros(value: unknown, sourceId: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) {
    throw new TypeError(`${sourceId} returned an invalid decimal ETH/USD price`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, "0"));
  const roundingDigit = Number(fraction[6] ?? "0");
  const rounded = roundingDigit >= 5 ? micros + 1n : micros;
  if (rounded <= 0n) throw new RangeError(`${sourceId} returned a non-positive ETH/USD price`);
  return rounded;
}

async function fetchJson(url: string, fetchFn: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetchFn(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`price endpoint returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function coinbasePrice(nowMs: number, fetchFn: typeof fetch): Promise<PriceObservation> {
  const payload = (await fetchJson("https://api.coinbase.com/v2/prices/ETH-USD/spot", fetchFn)) as {
    readonly data?: { readonly amount?: unknown };
  };
  return Object.freeze({
    sourceId: "coinbase-spot",
    usdMicrosPerEth: decimalUsdToMicros(payload.data?.amount, "coinbase-spot"),
    observedAtMs: nowMs,
    evidenceId: `coinbase-spot:${nowMs}`,
  });
}

async function krakenPrice(nowMs: number, fetchFn: typeof fetch): Promise<PriceObservation> {
  const payload = (await fetchJson(
    "https://api.kraken.com/0/public/Ticker?pair=ETHUSD",
    fetchFn,
  )) as {
    readonly result?: Readonly<Record<string, { readonly c?: readonly unknown[] }>>;
  };
  const ticker = Object.values(payload.result ?? {})[0];
  return Object.freeze({
    sourceId: "kraken-ticker",
    usdMicrosPerEth: decimalUsdToMicros(ticker?.c?.[0], "kraken-ticker"),
    observedAtMs: nowMs,
    evidenceId: `kraken-ticker:${nowMs}`,
  });
}

export async function fetchProductionPriceSnapshot(
  nowMs = Date.now(),
  fetchFn: typeof fetch = fetch,
): Promise<PriceSnapshot> {
  return freezePriceSnapshot(
    () => coinbasePrice(nowMs, fetchFn),
    () => krakenPrice(nowMs, fetchFn),
    {
      nominalUsdMicrosPerBatch: CLOCKIN_POLICY_V2.nominalLaneUsdMicros,
      maximumAgeMs: CLOCKIN_POLICY_V2.priceMaximumAgeMs,
      maximumDeviationBps: CLOCKIN_POLICY_V2.priceMaximumDeviationBps,
    },
    nowMs,
  );
}

export class ProductionPriceCache {
  readonly #fetch: (nowMs: number) => Promise<PriceSnapshot>;
  #snapshot: PriceSnapshot | null = null;

  constructor(fetcher: (nowMs: number) => Promise<PriceSnapshot> = fetchProductionPriceSnapshot) {
    this.#fetch = fetcher;
  }

  async refresh(nowMs = Date.now()): Promise<PriceSnapshot> {
    const snapshot = await this.#fetch(nowMs);
    this.#snapshot = snapshot;
    return snapshot;
  }

  current(nowMs = Date.now()): PriceSnapshot {
    if (this.#snapshot === null) throw new Error("production price snapshot is missing");
    assertFreshPriceSnapshot(this.#snapshot, nowMs);
    return this.#snapshot;
  }
}
