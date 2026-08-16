import { CanonicalInvariantError, stableHash } from "../core/canonical.js";

export interface RouteCandidateInput {
  readonly launchId: string;
  readonly tokenAddress: `0x${string}`;
  readonly quoteAddress: `0x${string}`;
  readonly poolAddress: `0x${string}`;
  readonly factoryAddress: `0x${string}`;
  readonly factoryCodeHash: `0x${string}`;
  readonly poolCodeHash: `0x${string}`;
  readonly reserveTokenRaw: bigint;
  readonly reserveQuoteRaw: bigint;
  readonly finalizeTxHash?: `0x${string}`;
  readonly observedBlock: bigint;
}

export interface VerifiedRouteCandidate extends RouteCandidateInput {
  readonly routeId: string;
  readonly state: "VERIFIED";
}

export interface RouteCandidatePolicy {
  readonly expectedLaunchId: string;
  readonly expectedTokenAddress: `0x${string}`;
  readonly allowedQuoteAddresses: ReadonlySet<string>;
  readonly allowedFactoryCodeHashes: ReadonlyMap<string, string>;
  readonly allowedPoolCodeHashes: ReadonlySet<string>;
  readonly requireFinalizeReceipt: boolean;
}

export function verifyRouteCandidate(
  input: RouteCandidateInput,
  allowedFactories: ReadonlyMap<string, string>,
): VerifiedRouteCandidate {
  const expectedHash = allowedFactories.get(input.factoryAddress.toLowerCase());
  if (
    expectedHash === undefined ||
    expectedHash.toLowerCase() !== input.factoryCodeHash.toLowerCase()
  ) {
    throw new CanonicalInvariantError("ROUTE_UNAVAILABLE", "external Factory identity mismatch");
  }
  if (input.reserveTokenRaw <= 0n || input.reserveQuoteRaw <= 0n) {
    throw new CanonicalInvariantError(
      "LIQUIDITY_ZERO",
      "external pool has no executable liquidity",
    );
  }
  return Object.freeze({
    ...input,
    routeId: `route:${stableHash({
      launchId: input.launchId,
      poolAddress: input.poolAddress,
      factoryAddress: input.factoryAddress,
      observedBlock: input.observedBlock.toString(),
    })}`,
    state: "VERIFIED",
  });
}

export function verifyBoundRouteCandidate(
  input: RouteCandidateInput,
  policy: RouteCandidatePolicy,
): VerifiedRouteCandidate {
  if (input.launchId !== policy.expectedLaunchId) {
    throw new CanonicalInvariantError(
      "ROUTE_UNAVAILABLE",
      "external route launch binding mismatch",
    );
  }
  if (input.tokenAddress.toLowerCase() !== policy.expectedTokenAddress.toLowerCase()) {
    throw new CanonicalInvariantError("IDENTITY_CONFLICT", "external route token mismatch");
  }
  if (!policy.allowedQuoteAddresses.has(input.quoteAddress.toLowerCase())) {
    throw new CanonicalInvariantError("ROUTE_UNAVAILABLE", "external quote asset is not allowed");
  }
  if (!policy.allowedPoolCodeHashes.has(input.poolCodeHash.toLowerCase())) {
    throw new CanonicalInvariantError("ROUTE_UNAVAILABLE", "external pool code identity mismatch");
  }
  if (policy.requireFinalizeReceipt && input.finalizeTxHash === undefined) {
    throw new CanonicalInvariantError("ROUTE_UNAVAILABLE", "finalize receipt binding is missing");
  }
  return verifyRouteCandidate(input, policy.allowedFactoryCodeHashes);
}
