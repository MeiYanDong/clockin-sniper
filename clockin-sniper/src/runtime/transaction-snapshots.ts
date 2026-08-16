import { getAddress, isHexString } from "ethers";

import type { Address, Hex32 } from "../core/canonical.js";

interface BaseBroadcastSnapshot {
  readonly formatVersion: 1;
  readonly kind: "ENTRY_BUY" | "EXIT_APPROVAL" | "EXIT_SELL";
  readonly validityExpiresAt: string;
}

export interface EntryBroadcastSnapshot extends BaseBroadcastSnapshot {
  readonly kind: "ENTRY_BUY";
  readonly principalBalanceBeforeRaw: string;
  readonly tokenBalanceBeforeRaw: string;
  readonly plannedPrincipalRaw: string;
  readonly expectedTokenOutRaw: string;
  readonly quoteId: string;
  readonly quoteBlock: string;
  readonly quoteBlockHash: Hex32;
}

export interface ExitApprovalBroadcastSnapshot extends BaseBroadcastSnapshot {
  readonly kind: "EXIT_APPROVAL";
  readonly lotId: string;
  readonly routeId: string;
  readonly tokenAddress: Address;
  readonly spender: Address;
  readonly expectedAllowanceRaw: string;
}

export interface ExitSellBroadcastSnapshot extends BaseBroadcastSnapshot {
  readonly kind: "EXIT_SELL";
  readonly exitPlanId: string;
  readonly lotId: string;
  readonly routeQuoteId: string;
  readonly quoteAsset: Address;
  readonly tokenBalanceBeforeRaw: string;
  readonly quoteBalanceBeforeRaw: string;
  readonly expectedTokenInputRaw: string;
  readonly minimumQuoteOutputRaw: string;
}

export type ProductionBroadcastSnapshot =
  | EntryBroadcastSnapshot
  | ExitApprovalBroadcastSnapshot
  | ExitSellBroadcastSnapshot;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("pre-broadcast snapshot must be an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function decimal(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!/^(0|[1-9][0-9]*)$/u.test(parsed)) {
    throw new TypeError(`${label} must be a canonical non-negative integer string`);
  }
  return parsed;
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!Number.isFinite(Date.parse(parsed))) throw new TypeError(`${label} must be ISO-8601`);
  return new Date(parsed).toISOString();
}

function address(value: unknown, label: string): Address {
  try {
    return getAddress(text(value, label)) as Address;
  } catch (error) {
    throw new TypeError(`${label} must be an EVM address`, { cause: error });
  }
}

function hash(value: unknown, label: string): Hex32 {
  const parsed = text(value, label);
  if (!isHexString(parsed, 32)) throw new TypeError(`${label} must be a 32-byte hash`);
  return parsed.toLowerCase() as Hex32;
}

export function parseProductionBroadcastSnapshot(value: unknown): ProductionBroadcastSnapshot {
  const input = record(value);
  if (input.formatVersion !== 1) throw new TypeError("snapshot formatVersion must be 1");
  const validityExpiresAt = timestamp(input.validityExpiresAt, "snapshot.validityExpiresAt");
  if (input.kind === "ENTRY_BUY") {
    return Object.freeze({
      formatVersion: 1,
      kind: "ENTRY_BUY",
      validityExpiresAt,
      principalBalanceBeforeRaw: decimal(
        input.principalBalanceBeforeRaw,
        "snapshot.principalBalanceBeforeRaw",
      ),
      tokenBalanceBeforeRaw: decimal(input.tokenBalanceBeforeRaw, "snapshot.tokenBalanceBeforeRaw"),
      plannedPrincipalRaw: decimal(input.plannedPrincipalRaw, "snapshot.plannedPrincipalRaw"),
      expectedTokenOutRaw: decimal(input.expectedTokenOutRaw, "snapshot.expectedTokenOutRaw"),
      quoteId: text(input.quoteId, "snapshot.quoteId"),
      quoteBlock: decimal(input.quoteBlock, "snapshot.quoteBlock"),
      quoteBlockHash: hash(input.quoteBlockHash, "snapshot.quoteBlockHash"),
    });
  }
  if (input.kind === "EXIT_APPROVAL") {
    return Object.freeze({
      formatVersion: 1,
      kind: "EXIT_APPROVAL",
      validityExpiresAt,
      lotId: text(input.lotId, "snapshot.lotId"),
      routeId: text(input.routeId, "snapshot.routeId"),
      tokenAddress: address(input.tokenAddress, "snapshot.tokenAddress"),
      spender: address(input.spender, "snapshot.spender"),
      expectedAllowanceRaw: decimal(input.expectedAllowanceRaw, "snapshot.expectedAllowanceRaw"),
    });
  }
  if (input.kind === "EXIT_SELL") {
    return Object.freeze({
      formatVersion: 1,
      kind: "EXIT_SELL",
      validityExpiresAt,
      exitPlanId: text(input.exitPlanId, "snapshot.exitPlanId"),
      lotId: text(input.lotId, "snapshot.lotId"),
      routeQuoteId: text(input.routeQuoteId, "snapshot.routeQuoteId"),
      quoteAsset: address(input.quoteAsset, "snapshot.quoteAsset"),
      tokenBalanceBeforeRaw: decimal(input.tokenBalanceBeforeRaw, "snapshot.tokenBalanceBeforeRaw"),
      quoteBalanceBeforeRaw: decimal(input.quoteBalanceBeforeRaw, "snapshot.quoteBalanceBeforeRaw"),
      expectedTokenInputRaw: decimal(input.expectedTokenInputRaw, "snapshot.expectedTokenInputRaw"),
      minimumQuoteOutputRaw: decimal(input.minimumQuoteOutputRaw, "snapshot.minimumQuoteOutputRaw"),
    });
  }
  throw new TypeError("snapshot kind is unsupported");
}

export function snapshotEventKind(snapshot: ProductionBroadcastSnapshot): string {
  return snapshot.kind === "ENTRY_BUY"
    ? "ENTRY_PRE_BROADCAST_SNAPSHOT"
    : snapshot.kind === "EXIT_APPROVAL"
      ? "EXIT_APPROVAL_PRE_BROADCAST_SNAPSHOT"
      : "EXIT_SELL_PRE_BROADCAST_SNAPSHOT";
}
