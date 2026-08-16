export interface OperationalReadinessInput {
  readonly chain: {
    readonly connected: boolean;
    readonly observedChainId?: number;
    readonly expectedChainId: number;
    readonly latestBlock?: string;
    readonly lagBlocks?: number;
  };
  readonly transport: {
    readonly rpcHttpReady: boolean;
    readonly rpcWssReady: boolean;
    readonly sequencerReady: boolean;
    readonly providerIds: readonly string[];
  };
  readonly factory: {
    readonly state: "UNKNOWN" | "OBSERVED" | "VERIFIED" | "HOT_ARMED" | "STALE" | "QUARANTINED";
    readonly profileId?: string;
    readonly profileRevision?: number;
  };
  readonly wallets: {
    readonly expected: number;
    readonly signerReady: number;
    readonly nonceReady: number;
    readonly fundingReady: number;
  };
  readonly priceSnapshot: {
    readonly state: "MISSING" | "FRESH" | "STALE" | "DIVERGENT";
    readonly snapshotId?: string;
    readonly expiresAt?: string;
  };
  readonly database: {
    readonly walEnabled: boolean;
    readonly leaseOwned: boolean;
    readonly schemaVersion: number;
  };
  readonly identity: {
    readonly level: "L0" | "L1" | "L2" | "L3" | "L4";
    readonly caState: "UNKNOWN" | "PENDING" | "CONFIRMED" | "MISMATCH";
  };
  readonly strategy: {
    readonly entryEnabled: boolean;
    readonly exitEnabled: boolean;
    readonly entryState: string;
    readonly exitState: string;
  };
  readonly exposure: {
    readonly unknownAttemptCount: number;
    readonly openPositionCount: number;
    readonly verifiedExitRouteCount: number;
  };
}

export interface OperationalReadiness {
  readonly ready: boolean;
  readonly hotArmed: boolean;
  readonly reasons: readonly string[];
  readonly snapshot: OperationalReadinessInput;
}

export function evaluateOperationalReadiness(
  input: OperationalReadinessInput,
): OperationalReadiness {
  const reasons: string[] = [];
  if (!input.chain.connected) reasons.push("chain RPC is disconnected");
  if (input.chain.observedChainId !== input.chain.expectedChainId) {
    reasons.push("observed chainId does not match configured chainId");
  }
  if (!input.transport.rpcHttpReady) reasons.push("HTTP RPC is not ready");
  if (!input.transport.rpcWssReady) reasons.push("WSS RPC is not ready");
  if (!input.transport.sequencerReady) reasons.push("direct Sequencer route is not ready");
  if (input.factory.state !== "HOT_ARMED") reasons.push("Factory/Profile is not HOT_ARMED");
  if ((input.factory.profileRevision ?? 0) < 1) reasons.push("Factory/Profile revision is missing");
  if (input.wallets.expected !== 10) reasons.push("wallet readiness expects exactly 10 lanes");
  if (input.wallets.signerReady !== input.wallets.expected)
    reasons.push("not all signers are ready");
  if (input.wallets.nonceReady !== input.wallets.expected)
    reasons.push("not all wallet nonces are ready");
  if (input.wallets.fundingReady !== input.wallets.expected)
    reasons.push("not all wallets are funded");
  if (input.priceSnapshot.state !== "FRESH") reasons.push("5U price snapshot is not fresh");
  if (!input.database.walEnabled) reasons.push("SQLite WAL is not enabled");
  if (!input.database.leaseOwned) reasons.push("active database/service lease is not owned");
  if (input.identity.caState === "MISMATCH")
    reasons.push("official CA conflicts with frozen identity");
  if (!input.strategy.entryEnabled) reasons.push("entry is disabled");
  const hotArmed = reasons.length === 0;
  return Object.freeze({
    ready: hotArmed,
    hotArmed,
    reasons: Object.freeze(reasons),
    snapshot: Object.freeze(input),
  });
}
