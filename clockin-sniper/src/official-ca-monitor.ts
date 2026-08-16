import { readFile } from "node:fs/promises";

import { getAddress } from "ethers";

import type { Hex } from "./rpc/types.js";

export type OfficialCaState = "pending" | "confirmed" | "mismatch";

export interface OfficialCaSnapshot {
  readonly state: OfficialCaState;
  readonly expectedToken: Hex;
  readonly observedAddress: Hex | null;
  readonly source: "initial" | "file" | "url" | null;
  readonly checkedAtMs: number;
  readonly lastError: string | null;
}

export interface OfficialCaMonitorOptions {
  readonly expectedToken: Hex;
  readonly initialAddress?: Hex;
  readonly filePath?: string;
  readonly url?: string;
  readonly jsonKey?: string;
  readonly pollMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly onChange?: (snapshot: OfficialCaSnapshot) => void | Promise<void>;
}

interface CaEvidence {
  readonly address: Hex;
  readonly source: "initial" | "file" | "url";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exactAddress(value: string): Hex | null {
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  return getAddress(trimmed) as Hex;
}

export function extractOfficialCa(text: string, jsonKey = "contractAddress"): Hex | null {
  const exact = exactAddress(text);
  if (exact !== null) return exact;
  const escapedKey = jsonKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`["']${escapedKey}["']\\s*:\\s*["'](0x[0-9a-fA-F]{40})["']`, "g");
  const addresses = new Set<string>();
  for (const match of text.matchAll(expression)) {
    const value = match[1];
    if (value !== undefined) addresses.add(getAddress(value));
  }
  if (addresses.size > 1) {
    throw new Error(`official CA source contains multiple ${jsonKey} addresses`);
  }
  const [only] = addresses;
  return only === undefined ? null : (only as Hex);
}

export class OfficialCaMonitor {
  readonly #options: OfficialCaMonitorOptions;
  readonly #pollMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #snapshot: OfficialCaSnapshot;
  #timer: ReturnType<typeof setInterval> | null = null;
  #polling = false;

  constructor(options: OfficialCaMonitorOptions) {
    const pollMs = options.pollMs ?? 500;
    if (!Number.isSafeInteger(pollMs) || pollMs <= 0) {
      throw new RangeError("official CA pollMs must be a positive safe integer");
    }
    if (
      options.initialAddress === undefined &&
      options.filePath === undefined &&
      options.url === undefined
    ) {
      throw new Error("at least one official CA source is required");
    }
    this.#options = Object.freeze({ ...options });
    this.#pollMs = pollMs;
    this.#fetch = options.fetchFn ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#snapshot = Object.freeze({
      state: "pending",
      expectedToken: getAddress(options.expectedToken) as Hex,
      observedAddress: null,
      source: null,
      checkedAtMs: this.#now(),
      lastError: null,
    });
  }

  snapshot(): OfficialCaSnapshot {
    return this.#snapshot;
  }

  async pollOnce(): Promise<OfficialCaSnapshot> {
    if (this.#snapshot.state !== "pending") return this.#snapshot;
    const evidence: CaEvidence[] = [];
    const errors: string[] = [];

    if (this.#options.initialAddress !== undefined) {
      evidence.push({
        address: getAddress(this.#options.initialAddress) as Hex,
        source: "initial",
      });
    }
    if (this.#options.filePath !== undefined) {
      try {
        const text = await readFile(this.#options.filePath, "utf8");
        const address = extractOfficialCa(text, this.#options.jsonKey);
        if (address !== null) evidence.push({ address, source: "file" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          errors.push(`file: ${messageOf(error)}`);
        }
      }
    }
    if (this.#options.url !== undefined) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(2_000, this.#pollMs * 2));
      try {
        const response = await this.#fetch(this.#options.url, {
          headers: { accept: "text/html,application/json" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const address = extractOfficialCa(await response.text(), this.#options.jsonKey);
        if (address !== null) evidence.push({ address, source: "url" });
      } catch (error) {
        errors.push(`url: ${messageOf(error)}`);
      } finally {
        clearTimeout(timeout);
      }
    }

    const distinct = new Map(evidence.map((entry) => [entry.address.toLowerCase(), entry]));
    let next: OfficialCaSnapshot;
    if (distinct.size > 1) {
      next = Object.freeze({
        state: "mismatch",
        expectedToken: this.#snapshot.expectedToken,
        observedAddress: null,
        source: null,
        checkedAtMs: this.#now(),
        lastError: "official CA sources disagree",
      });
    } else {
      const [observed] = distinct.values();
      if (observed === undefined) {
        next = Object.freeze({
          ...this.#snapshot,
          checkedAtMs: this.#now(),
          lastError: errors.length === 0 ? null : errors.join("; "),
        });
      } else {
        next = Object.freeze({
          state:
            observed.address.toLowerCase() === this.#snapshot.expectedToken.toLowerCase()
              ? "confirmed"
              : "mismatch",
          expectedToken: this.#snapshot.expectedToken,
          observedAddress: observed.address,
          source: observed.source,
          checkedAtMs: this.#now(),
          lastError: null,
        });
      }
    }

    const changed =
      next.state !== this.#snapshot.state ||
      next.observedAddress !== this.#snapshot.observedAddress ||
      next.source !== this.#snapshot.source;
    this.#snapshot = next;
    if (changed) await this.#options.onChange?.(next);
    return next;
  }

  async start(): Promise<void> {
    if (this.#timer !== null) return;
    await this.pollOnce();
    if (this.#snapshot.state !== "pending") return;
    this.#timer = setInterval(() => {
      if (this.#polling || this.#snapshot.state !== "pending") return;
      this.#polling = true;
      void this.pollOnce().finally(() => {
        this.#polling = false;
        if (this.#snapshot.state !== "pending") this.stop();
      });
    }, this.#pollMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
