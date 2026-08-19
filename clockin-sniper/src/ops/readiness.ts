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
  readonly canaryArmed: boolean;
  readonly hotArmed: boolean;
  readonly canaryReasons: readonly string[];
  readonly fullDeploymentReasons: readonly string[];
  readonly reasons: readonly string[];
  readonly snapshot: OperationalReadinessInput;
}

export function evaluateOperationalReadiness(
  input: OperationalReadinessInput,
): OperationalReadiness {
  const canaryReasons: string[] = [];
  if (!input.chain.connected) canaryReasons.push("chain RPC is disconnected");
  if (input.chain.observedChainId !== input.chain.expectedChainId) {
    canaryReasons.push("observed chainId does not match configured chainId");
  }
  if (!input.transport.rpcHttpReady) canaryReasons.push("HTTP RPC is not ready");
  if (!input.transport.rpcWssReady) canaryReasons.push("WSS RPC is not ready");
  if (!input.transport.sequencerReady) canaryReasons.push("direct Sequencer route is not ready");
  if (input.factory.state !== "HOT_ARMED") canaryReasons.push("Factory/Profile is not HOT_ARMED");
  if ((input.factory.profileRevision ?? 0) < 1)
    canaryReasons.push("Factory/Profile revision is missing");
  if (input.wallets.expected !== 10)
    canaryReasons.push("wallet readiness expects exactly 10 lanes");
  if (input.wallets.signerReady < 1) canaryReasons.push("canary signer is not ready");
  if (input.wallets.nonceReady < 1) canaryReasons.push("canary wallet nonce is not ready");
  if (input.wallets.fundingReady < 1) canaryReasons.push("canary wallet is not funded");
  if (input.priceSnapshot.state !== "FRESH") canaryReasons.push("5U price snapshot is not fresh");
  if (!input.database.walEnabled) canaryReasons.push("SQLite WAL is not enabled");
  if (!input.database.leaseOwned) canaryReasons.push("active database/service lease is not owned");
  if (input.identity.caState === "MISMATCH")
    canaryReasons.push("official CA conflicts with frozen identity");
  if (
    input.identity.level !== "L2" &&
    input.identity.level !== "L3" &&
    input.identity.level !== "L4"
  )
    canaryReasons.push("bounded canary requires at least L2 identity");
  if (!input.strategy.entryEnabled) canaryReasons.push("entry is disabled");
  if (input.exposure.unknownAttemptCount > 0)
    canaryReasons.push("unresolved transaction attempts require reconciliation");

  const fullDeploymentReasons = [...canaryReasons];
  if (input.identity.level !== "L3" && input.identity.level !== "L4")
    fullDeploymentReasons.push("full deployment requires at least L3 identity");
  if (input.wallets.signerReady !== input.wallets.expected)
    fullDeploymentReasons.push("not all signers are ready");
  if (input.wallets.nonceReady !== input.wallets.expected)
    fullDeploymentReasons.push("not all wallet nonces are ready");
  if (input.wallets.fundingReady !== input.wallets.expected)
    fullDeploymentReasons.push("not all wallets are funded");
  if (!input.strategy.exitEnabled) fullDeploymentReasons.push("exit or reconciliation is disabled");
  if (input.exposure.verifiedExitRouteCount < 1)
    fullDeploymentReasons.push("no verified executable exit route is ready");
  const canaryArmed = canaryReasons.length === 0;
  const hotArmed = fullDeploymentReasons.length === 0;
  return Object.freeze({
    ready: hotArmed,
    canaryArmed,
    hotArmed,
    canaryReasons: Object.freeze(canaryReasons),
    fullDeploymentReasons: Object.freeze(fullDeploymentReasons),
    reasons: Object.freeze(fullDeploymentReasons),
    snapshot: Object.freeze(input),
  });
}
