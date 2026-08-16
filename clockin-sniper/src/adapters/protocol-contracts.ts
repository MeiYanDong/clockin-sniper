import type {
  Address,
  FactoryCandidate,
  FactoryProfile,
  LaunchCandidate,
  LaunchIdentity,
  RouteQuote,
} from "../core/canonical.js";
import type { PoolReadAdapter } from "../entry/pool-observation.js";
import type { QuoteSnapshot } from "../entry/quote-policy.js";
import type { ProtocolAdapterCapabilities } from "./capability-manifest.js";
import type { SellTransactionTemplate, VerifiedRouteProfile } from "./sell-adapter.js";

export interface FactoryAdapter {
  readonly adapterId: string;
  readonly capabilities: ProtocolAdapterCapabilities;
  readonly launchEventTopics: readonly `0x${string}`[];
  fingerprint(candidate: FactoryCandidate, blockNumber: bigint): Promise<FactoryProfile>;
  decodeLaunch(log: unknown, profile: FactoryProfile): LaunchCandidate;
  reconcileRemoved(candidate: LaunchCandidate): LaunchCandidate;
}

export interface VersionedPoolReadAdapter extends PoolReadAdapter {
  readonly capabilities: ProtocolAdapterCapabilities;
  readonly profileRevision: number;
}

export interface EntryTransactionTemplate {
  readonly adapterId: string;
  readonly profileRevision: number;
  readonly walletAddress: Address;
  readonly target: Address;
  readonly valueRaw: bigint;
  readonly calldata: `0x${string}`;
  readonly minOutputRaw: bigint;
  readonly quoteId?: string;
  readonly earliestValidBlock: bigint;
  readonly expectedEffectAssets: readonly Address[];
}

export function assertDirectEoaEntryPath(input: {
  template: EntryTransactionTemplate;
  identity: LaunchIdentity;
  walletRuntimeCode: `0x${string}`;
  eoaOnlyActive: boolean;
}): void {
  if (!input.eoaOnlyActive) return;
  if (input.walletRuntimeCode !== "0x") {
    throw new Error("EOA-only window requires a wallet with empty runtime code");
  }
  if (input.template.walletAddress.toLowerCase() === input.template.target.toLowerCase()) {
    throw new Error("entry wallet cannot be the protocol target");
  }
  if (input.template.target.toLowerCase() !== input.identity.poolAddress.toLowerCase()) {
    throw new Error("EOA-only entry must call the frozen launch pool directly");
  }
}

export interface EntryAdapter {
  readonly adapterId: string;
  readonly capabilities: ProtocolAdapterCapabilities;
  previewBuy(
    identity: LaunchIdentity,
    principalRaw: bigint,
    blockNumber: bigint,
  ): Promise<QuoteSnapshot>;
  buildBuy(input: {
    identity: LaunchIdentity;
    walletAddress: Address;
    principalRaw: bigint;
    minOutputRaw: bigint;
    quote?: QuoteSnapshot;
    earliestValidBlock: bigint;
  }): Promise<EntryTransactionTemplate>;
}

export interface ExitAdapter {
  readonly adapterId: string;
  readonly capabilities: ProtocolAdapterCapabilities;
  quoteSell(
    profile: VerifiedRouteProfile,
    lotId: string,
    tokenInputRaw: bigint,
    blockNumber: bigint,
  ): Promise<RouteQuote>;
  buildSell(input: {
    profile: VerifiedRouteProfile;
    quote: RouteQuote;
    walletAddress: Address;
    minOutputRaw: bigint;
    deadlineTimestamp: bigint;
  }): Promise<SellTransactionTemplate>;
}

export interface FinalizeAdapter {
  readonly adapterId: string;
  readonly capabilities: ProtocolAdapterCapabilities;
  detectFinalize(
    logOrState: unknown,
    identity: LaunchIdentity,
  ): Promise<
    Readonly<{
      finalized: boolean;
      externalPool?: Address;
      evidenceIds: readonly string[];
    }>
  >;
}
