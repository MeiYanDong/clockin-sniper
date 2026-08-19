import { getBytes, keccak256 } from "ethers";

export interface BroadcastProviderIdentity {
  readonly chainId: number;
  readonly genesisHash: `0x${string}`;
  readonly writeCapable: boolean;
  readonly observedAt: string;
}

export interface SameRawProvider {
  readonly providerId: string;
  readonly region: string;
  probeIdentity(): Promise<BroadcastProviderIdentity>;
  sendRawTransaction(rawTransaction: `0x${string}`): Promise<`0x${string}`>;
}

export type ProviderBroadcastOutcome = Readonly<{
  providerId: string;
  region: string;
  txHash: `0x${string}`;
  result: "ACCEPTED" | "KNOWN" | "UNKNOWN" | "REJECTED";
  latencyMs: number;
  reason: string;
}>;

export interface SameRawBroadcastResult {
  readonly txHash: `0x${string}`;
  readonly state: "ACCEPTED" | "KNOWN" | "UNKNOWN" | "REJECTED";
  readonly outcomes: readonly ProviderBroadcastOutcome[];
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

function classifyFailure(error: unknown): {
  result: "KNOWN" | "UNKNOWN" | "REJECTED";
  reason: string;
} {
  const reason = error instanceof Error ? error.message : String(error);
  const message = errorMessage(error);
  if (message.includes("already known") || message.includes("known transaction")) {
    return { result: "KNOWN", reason };
  }

  // A route may be called REJECTED only when its response proves that this exact signed payload
  // failed validation before it could enter that route's transaction pool. Everything else is
  // UNKNOWN: JSON-RPC internal errors, transport failures, unfamiliar provider text and even
  // nonce-related responses cannot prove that another route did not accept the same bytes.
  const deterministicPreAcceptanceRejections = [
    /\binvalid sender\b/u,
    /\binvalid signature\b/u,
    /\binvalid chain id\b/u,
    /\binvalid chainid\b/u,
    /\bchain id mismatch\b/u,
    /\binvalid transaction type\b/u,
    /\btransaction type not supported\b/u,
    /\bunsupported transaction type\b/u,
    /\binvalid rlp\b/u,
    /\brlp(?:\s+decode|\s+encoding)? error\b/u,
    /\bintrinsic gas too low\b/u,
    /\binsufficient funds(?: for (?:gas \* price \+ value|gas \* price \+ value \+ blob fee|transfer))?\b/u,
  ];
  if (deterministicPreAcceptanceRejections.some((pattern) => pattern.test(message))) {
    return { result: "REJECTED", reason };
  }
  return { result: "UNKNOWN", reason };
}

export class SameRawBroadcaster {
  readonly #providers: readonly SameRawProvider[];
  readonly #expectedChainId: number;
  readonly #expectedGenesisHash: string;
  readonly #now: () => number;
  #preflighted = false;

  constructor(options: {
    providers: readonly SameRawProvider[];
    expectedChainId: number;
    expectedGenesisHash: `0x${string}`;
    now?: () => number;
  }) {
    if (options.providers.length === 0) throw new RangeError("at least one provider is required");
    if (
      new Set(options.providers.map((provider) => provider.providerId)).size !==
      options.providers.length
    ) {
      throw new RangeError("broadcast provider IDs must be unique");
    }
    this.#providers = Object.freeze([...options.providers]);
    this.#expectedChainId = options.expectedChainId;
    this.#expectedGenesisHash = options.expectedGenesisHash.toLowerCase();
    this.#now = options.now ?? Date.now;
  }

  async preflight(): Promise<readonly BroadcastProviderIdentity[]> {
    const identities = await Promise.all(
      this.#providers.map((provider) => provider.probeIdentity()),
    );
    for (const [index, identity] of identities.entries()) {
      const provider = this.#providers[index] as SameRawProvider;
      if (identity.chainId !== this.#expectedChainId) {
        throw new Error(`provider ${provider.providerId} returned wrong chainId`);
      }
      if (identity.genesisHash.toLowerCase() !== this.#expectedGenesisHash) {
        throw new Error(`provider ${provider.providerId} returned wrong genesis hash`);
      }
      if (!identity.writeCapable) {
        throw new Error(`provider ${provider.providerId} did not prove write capability`);
      }
    }
    this.#preflighted = true;
    return Object.freeze(identities.map((identity) => Object.freeze({ ...identity })));
  }

  async broadcast(rawTransaction: `0x${string}`): Promise<SameRawBroadcastResult> {
    if (!this.#preflighted) throw new Error("broadcast providers have not passed preflight");
    const txHash = keccak256(getBytes(rawTransaction)) as `0x${string}`;
    const outcomes = await Promise.all(
      this.#providers.map(async (provider): Promise<ProviderBroadcastOutcome> => {
        const startedAt = this.#now();
        try {
          const returnedHash = await provider.sendRawTransaction(rawTransaction);
          const latencyMs = Math.max(0, this.#now() - startedAt);
          if (returnedHash.toLowerCase() !== txHash.toLowerCase()) {
            return Object.freeze({
              providerId: provider.providerId,
              region: provider.region,
              txHash,
              result: "UNKNOWN",
              latencyMs,
              reason:
                "provider returned a hash different from the signed payload; submission state is unknown",
            });
          }
          return Object.freeze({
            providerId: provider.providerId,
            region: provider.region,
            txHash,
            result: "ACCEPTED",
            latencyMs,
            reason: "provider accepted the signed payload",
          });
        } catch (error) {
          const classified = classifyFailure(error);
          return Object.freeze({
            providerId: provider.providerId,
            region: provider.region,
            txHash,
            result: classified.result,
            latencyMs: Math.max(0, this.#now() - startedAt),
            reason: classified.reason,
          });
        }
      }),
    );
    const state: SameRawBroadcastResult["state"] = outcomes.some(
      (outcome) => outcome.result === "ACCEPTED",
    )
      ? "ACCEPTED"
      : outcomes.some((outcome) => outcome.result === "KNOWN")
        ? "KNOWN"
        : outcomes.some((outcome) => outcome.result === "UNKNOWN")
          ? "UNKNOWN"
          : "REJECTED";
    return Object.freeze({ txHash, state, outcomes: Object.freeze(outcomes) });
  }
}
