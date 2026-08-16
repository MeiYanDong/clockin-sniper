import { stableHash, type Address, type Hex32, type IsoTimestamp } from "../core/canonical.js";
import type { AllowanceMode, VerifiedRouteProfile } from "../adapters/sell-adapter.js";

export interface ExternalRouteCandidate {
  readonly routeId: string;
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
  readonly currentSellQuoteRaw: bigint;
  readonly allowanceMode: AllowanceMode;
  readonly finalizeEvidenceId: string;
  readonly evidenceIds: readonly string[];
}

export interface ExternalRouteAllowlist {
  readonly chainId: number;
  readonly tokenAddress: Address;
  readonly quoteAsset: Address;
  readonly factoryCodeHashes: ReadonlySet<string>;
  readonly routerCodeHashes: ReadonlySet<string>;
}

export class ExternalRouteRegistry {
  readonly #profiles = new Map<string, VerifiedRouteProfile>();
  readonly #fingerprints = new Map<string, string>();

  verify(
    candidate: ExternalRouteCandidate,
    allowlist: ExternalRouteAllowlist,
    verifiedAt: IsoTimestamp,
  ): VerifiedRouteProfile {
    if (candidate.chainId !== allowlist.chainId) throw new Error("external route chain mismatch");
    if (candidate.tokenAddress.toLowerCase() !== allowlist.tokenAddress.toLowerCase()) {
      throw new Error("external route token mismatch");
    }
    if (candidate.quoteAsset.toLowerCase() !== allowlist.quoteAsset.toLowerCase()) {
      throw new Error("external route quote asset mismatch");
    }
    if (!allowlist.factoryCodeHashes.has(candidate.factoryCodeHash.toLowerCase())) {
      throw new Error("external Factory code hash is not allowlisted");
    }
    if (!allowlist.routerCodeHashes.has(candidate.routerCodeHash.toLowerCase())) {
      throw new Error("external Router code hash is not allowlisted");
    }
    if (candidate.liquidityRaw <= 0n || candidate.currentSellQuoteRaw <= 0n) {
      throw new Error("PairCreated without executable liquidity/quote is not a route");
    }
    const previous = this.#profiles.get(candidate.routeId);
    const fingerprint = stableHash(candidate);
    if (previous !== undefined && this.#fingerprints.get(candidate.routeId) === fingerprint) {
      return previous;
    }
    const revision = previous === undefined ? 1 : previous.revision + 1;
    const profile: VerifiedRouteProfile = Object.freeze({
      routeId: candidate.routeId,
      revision,
      routeKind: "EXTERNAL_AMM",
      state: "VERIFIED",
      chainId: candidate.chainId,
      tokenAddress: candidate.tokenAddress,
      quoteAsset: candidate.quoteAsset,
      poolAddress: candidate.poolAddress,
      routerAddress: candidate.routerAddress,
      factoryAddress: candidate.factoryAddress,
      factoryCodeHash: candidate.factoryCodeHash,
      routerCodeHash: candidate.routerCodeHash,
      poolCodeHash: candidate.poolCodeHash,
      feeTierBps: candidate.feeTierBps,
      liquidityRaw: candidate.liquidityRaw,
      allowanceMode: candidate.allowanceMode,
      finalizeEvidenceId: candidate.finalizeEvidenceId,
      evidenceIds: Object.freeze([...candidate.evidenceIds]),
      verifiedAt,
    });
    this.#profiles.set(candidate.routeId, profile);
    this.#fingerprints.set(candidate.routeId, fingerprint);
    return profile;
  }

  markStale(routeId: string, verifiedAt: IsoTimestamp, evidenceId: string): VerifiedRouteProfile {
    const existing = this.#profiles.get(routeId);
    if (existing === undefined) throw new Error(`unknown route ${routeId}`);
    const stale: VerifiedRouteProfile = Object.freeze({
      ...existing,
      revision: existing.revision + 1,
      state: "STALE",
      evidenceIds: Object.freeze([...existing.evidenceIds, evidenceId]),
      verifiedAt,
    });
    this.#profiles.set(routeId, stale);
    return stale;
  }

  get(routeId: string): VerifiedRouteProfile | undefined {
    return this.#profiles.get(routeId);
  }
}
