import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { stableHash, type IsoTimestamp } from "../core/canonical.js";
import type { AuditEventInput, SqliteStore } from "./sqlite-store.js";

export interface LegacyLedgerRecord {
  readonly kind?: string;
  readonly event?: string;
  readonly at?: string;
  readonly timestamp?: string;
  readonly launchId?: string;
  readonly strategyId?: string;
  readonly intentId?: string;
  readonly planId?: string;
  readonly txHash?: string;
  readonly nonce?: string | number;
  readonly tokenDelta?: string;
  readonly tokenBalanceDeltaRaw?: string;
  readonly tokenBalanceDelta?: string;
  readonly [key: string]: unknown;
}

export interface MigrationResult {
  readonly imported: number;
  readonly duplicates: number;
  readonly unknownFields: readonly string[];
}

const knownFields = new Set([
  "kind",
  "event",
  "at",
  "timestamp",
  "launchId",
  "strategyId",
  "intentId",
  "planId",
  "txHash",
  "nonce",
  "tokenDelta",
  "tokenBalanceDeltaRaw",
  "tokenBalanceDelta",
]);

export type LegacyCanonicalTarget =
  | "SESSION_AUDIT"
  | "EXECUTION_PLAN_AUDIT"
  | "TRANSPORT_ATTEMPT_AUDIT"
  | "RECEIPT_EFFECT_AUDIT"
  | "TOKEN_BALANCE_AUDIT"
  | "POSITION_AUDIT"
  | "UNMAPPED_AUDIT";

export interface LegacyCanonicalProjection {
  readonly sourceKind: string;
  readonly target: LegacyCanonicalTarget;
  readonly txHash: Readonly<Record<string, unknown>>;
  readonly nonce: Readonly<Record<string, unknown>>;
  readonly tokenDelta: Readonly<Record<string, unknown>>;
}

function sourceKind(record: LegacyLedgerRecord): string {
  const value = record.kind ?? record.event;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("legacy record has no event/kind");
  }
  return value;
}

function legacyKnowledge(value: unknown, field: string): Readonly<Record<string, unknown>> {
  return value === undefined
    ? Object.freeze({ state: "UNKNOWN", reason: `legacy record omitted ${field}` })
    : Object.freeze({ state: "KNOWN", value });
}

export function projectLegacyRecord(record: LegacyLedgerRecord): LegacyCanonicalProjection {
  const kind = sourceKind(record);
  const target: LegacyCanonicalTarget =
    kind === "live_session_started" || kind === "live_session_finished"
      ? "SESSION_AUDIT"
      : kind === "plan_frozen"
        ? "EXECUTION_PLAN_AUDIT"
        : [
              "broadcast_attempted",
              "broadcast_result",
              "broadcast_rejected",
              "exact_raw_rebroadcast",
            ].includes(kind)
          ? "TRANSPORT_ATTEMPT_AUDIT"
          : kind === "receipt_observed" || kind === "reconciliation_unknown"
            ? "RECEIPT_EFFECT_AUDIT"
            : kind === "position_observed"
              ? "POSITION_AUDIT"
              : kind.includes("token_balance")
                ? "TOKEN_BALANCE_AUDIT"
                : "UNMAPPED_AUDIT";
  const tokenDelta = record.tokenDelta ?? record.tokenBalanceDeltaRaw ?? record.tokenBalanceDelta;
  return Object.freeze({
    sourceKind: kind,
    target,
    txHash: legacyKnowledge(record.txHash, "txHash"),
    nonce: legacyKnowledge(record.nonce, "nonce"),
    tokenDelta: legacyKnowledge(tokenDelta, "tokenDelta"),
  });
}

function timestamp(record: LegacyLedgerRecord): {
  readonly observedAt: IsoTimestamp;
  readonly knowledge: Readonly<Record<string, unknown>>;
} {
  const value = record.at ?? record.timestamp;
  if (value === undefined || Number.isNaN(Date.parse(value))) {
    return Object.freeze({
      observedAt: "1970-01-01T00:00:00.000Z",
      knowledge: Object.freeze({
        state: "UNKNOWN",
        reason: "legacy record has no valid source timestamp; epoch is an ordering placeholder",
      }),
    });
  }
  const observedAt = new Date(value).toISOString();
  return Object.freeze({
    observedAt,
    knowledge: Object.freeze({ state: "KNOWN", value: observedAt }),
  });
}

export function mapLegacyRecord(record: LegacyLedgerRecord, lineNumber: number): AuditEventInput {
  let projection: LegacyCanonicalProjection;
  try {
    projection = projectLegacyRecord(record);
  } catch {
    throw new TypeError(`legacy line ${lineNumber} has no event kind`);
  }
  const sourceTimestamp = timestamp(record);
  const fieldKnowledge = Object.fromEntries(
    ["launchId", "intentId", "planId", "txHash", "nonce", "tokenDelta"].map((field) => [
      field,
      record[field] === undefined
        ? Object.freeze({ state: "UNKNOWN", reason: `legacy record omitted ${field}` })
        : Object.freeze({ state: "KNOWN", value: record[field] }),
    ]),
  );
  const eventId = `legacy:${stableHash({ lineNumber, record })}`;
  return Object.freeze({
    eventId,
    eventKind: `legacy.${projection.sourceKind}`,
    strategyId: record.strategyId ?? "clockin-mainnet-v0",
    ...(record.launchId === undefined ? {} : { launchId: record.launchId }),
    objectId:
      record.txHash ??
      record.planId ??
      record.intentId ??
      record.launchId ??
      `legacy-line-${lineNumber}`,
    payload: Object.freeze({
      legacy: record,
      unknownFields: Object.keys(record)
        .filter((key) => !knownFields.has(key))
        .sort(),
      evidenceState: "repository_record",
      sourceTimestamp: sourceTimestamp.knowledge,
      fieldKnowledge,
      canonicalProjection: projection,
    }),
    observedAt: sourceTimestamp.observedAt,
  });
}

export async function importLegacyNdjson(
  store: SqliteStore,
  filename: string,
): Promise<MigrationResult> {
  const input = createInterface({ input: createReadStream(filename, { encoding: "utf8" }) });
  let imported = 0;
  let duplicates = 0;
  let lineNumber = 0;
  const unknownFields = new Set<string>();
  for await (const line of input) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line) as LegacyLedgerRecord;
    for (const key of Object.keys(record)) if (!knownFields.has(key)) unknownFields.add(key);
    const event = mapLegacyRecord(record, lineNumber);
    try {
      store.appendAuditEvent(event);
      imported += 1;
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        duplicates += 1;
        continue;
      }
      throw error;
    }
  }
  return Object.freeze({
    imported,
    duplicates,
    unknownFields: Object.freeze([...unknownFields].sort()),
  });
}

export function exportAuditNdjson(
  store: SqliteStore,
  strategyId: string,
  launchId?: string,
): string {
  return store
    .auditEvents(strategyId, launchId)
    .map((event) => JSON.stringify(event))
    .join("\n");
}
