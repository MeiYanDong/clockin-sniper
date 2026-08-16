import type { Address, Hex32, IsoTimestamp, RouteQuote } from "../core/canonical.js";

export type AllowanceMode = "NONE" | "APPROVE" | "PERMIT";

export interface VerifiedRouteProfile {
  readonly routeId: string;
  readonly revision: number;
  readonly routeKind: "LAUNCH_POOL" | "EXTERNAL_AMM";
  readonly state: "VERIFIED" | "STALE" | "UNAVAILABLE";
  readonly chainId: number;
  readonly tokenAddress: Address;
  readonly quoteAsset: Address;
  readonly poolAddress: Address;
  readonly routerAddress: Address;
  readonly factoryAddress: Address;
  readonly factoryCodeHash: Hex32;
  readonly routerCodeHash: Hex32;
  readonly poolCodeHash: Hex32;
  readonly feeTierBps: number;
  readonly liquidityRaw: bigint;
  readonly allowanceMode: AllowanceMode;
  readonly finalizeEvidenceId?: string;
  readonly evidenceIds: readonly string[];
  readonly verifiedAt: IsoTimestamp;
}

export interface SellQuoteRequest {
  readonly walletAddress: Address;
  readonly tokenInputRaw: bigint;
  readonly blockNumber: bigint;
  readonly blockHash: Hex32;
}

export interface SellTransactionTemplate {
  readonly routeId: string;
  readonly routeRevision: number;
  readonly walletAddress: Address;
  readonly allowanceMode: AllowanceMode;
  readonly approvalRequired: boolean;
  readonly approvalTarget?: Address;
  readonly to: Address;
  readonly calldata: `0x${string}`;
  readonly valueRaw: bigint;
  readonly tokenInputRaw: bigint;
  readonly expectedOutputRaw: bigint;
  readonly minOutputRaw: bigint;
  readonly deadlineTimestamp: bigint;
  readonly quoteId: string;
}

export interface VerifiedSellAdapter {
  readonly adapterId: string;
  readonly routeKind: "LAUNCH_POOL" | "EXTERNAL_AMM";
  quote(profile: VerifiedRouteProfile, request: SellQuoteRequest): Promise<RouteQuote>;
  buildSell(
    profile: VerifiedRouteProfile,
    quote: RouteQuote,
    walletAddress: Address,
    maximumSlippageBps: number,
    deadlineTimestamp: bigint,
  ): Promise<SellTransactionTemplate>;
}

export function assertExecutableRouteProfile(
  profile: VerifiedRouteProfile,
  expectedKind: VerifiedSellAdapter["routeKind"],
  expectedToken: Address,
): void {
  if (profile.state !== "VERIFIED") throw new Error(`route ${profile.routeId} is not verified`);
  if (profile.routeKind !== expectedKind) throw new Error("sell adapter route kind mismatch");
  if (profile.tokenAddress.toLowerCase() !== expectedToken.toLowerCase()) {
    throw new Error("sell route token does not match the frozen target");
  }
  if (profile.liquidityRaw <= 0n) throw new Error("sell route has zero executable liquidity");
  if (profile.routeKind === "EXTERNAL_AMM" && profile.finalizeEvidenceId === undefined) {
    throw new Error("external route lacks canonical finalize evidence");
  }
}
