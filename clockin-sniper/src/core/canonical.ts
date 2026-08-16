import { createHash } from "node:crypto";

export type Id = string;
export type IsoTimestamp = string;
export type DecimalString = string;
export type Hex32 = `0x${string}`;
export type Address = `0x${string}`;

export type EvidenceLevel =
  | "planned"
  | "repository_record"
  | "tested"
  | "historical_receipt"
  | "verified_current";

export type Knowledge<T> =
  | Readonly<{
      state: "KNOWN";
      value: T;
      observedAt: IsoTimestamp;
      expiresAt?: IsoTimestamp;
      evidenceIds: readonly Id[];
    }>
  | Readonly<{
      state: "UNKNOWN";
      reason: string;
      since: IsoTimestamp;
      lastCheckedAt?: IsoTimestamp;
    }>
  | Readonly<{ state: "UNSUPPORTED"; reason: string }>
  | Readonly<{
      state: "ERROR";
      reason: string;
      observedAt: IsoTimestamp;
      retryable: boolean;
    }>;

export interface EvidenceLink {
  readonly evidenceId: Id;
  readonly kind:
    | "source"
    | "chain_state"
    | "quote"
    | "signature"
    | "transport"
    | "receipt"
    | "event"
    | "balance"
    | "position"
    | "valuation"
    | "operator";
  readonly sourceId: string;
  readonly observedAt: IsoTimestamp;
  readonly blockRef?: string;
  readonly payloadHash: string;
}

export interface SignalEvidence {
  readonly evidenceId: Id;
  readonly strategyId: string;
  readonly revision: number;
  readonly sourceKind: "exact_factory" | "topic_wide" | "address_cluster" | "website" | "liquidity";
  readonly sourceId: string;
  readonly occurredAt: Knowledge<IsoTimestamp>;
  readonly observedAt: IsoTimestamp;
  readonly receivedMonotonicMs?: DecimalString;
  readonly chainId: number;
  readonly blockNumber?: DecimalString;
  readonly blockHash?: Hex32;
  readonly transactionHash?: Hex32;
  readonly transactionIndex?: DecimalString;
  readonly logIndex?: DecimalString;
  readonly removed: boolean;
  readonly payloadHash: string;
  readonly evidenceLevel: EvidenceLevel;
}

export type FactoryProfileState =
  | "OBSERVED"
  | "FINGERPRINTED"
  | "PROFILE_MATCHED"
  | "VERIFIED"
  | "HOT_ARMED"
  | "QUARANTINED"
  | "STALE_REVERIFY_REQUIRED";

export interface FactoryCandidate {
  readonly candidateId: Id;
  readonly strategyId: string;
  readonly revision: number;
  readonly chainId: number;
  readonly address: Address;
  readonly observedBlock: DecimalString;
  readonly runtimeCodeHash: Knowledge<Hex32>;
  readonly implementationAddress: Knowledge<Address>;
  readonly implementationCodeHash: Knowledge<Hex32>;
  readonly proxyType?: Knowledge<"NONE" | "EIP1967" | "BEACON" | "CUSTOM">;
  readonly adminAddress?: Knowledge<Address>;
  readonly beaconAddress?: Knowledge<Address>;
  readonly evidenceIds: readonly Id[];
  readonly createdAt: IsoTimestamp;
}

export interface FactoryProfile {
  readonly profileId: Id;
  readonly strategyId: string;
  readonly revision: number;
  readonly chainId: number;
  readonly address: Address;
  readonly deployedBlock: Knowledge<DecimalString>;
  readonly deploymentTxHash: Knowledge<Hex32>;
  readonly deployer: Knowledge<Address>;
  readonly runtimeCodeHash: Hex32;
  readonly proxyType: "NONE" | "EIP1967" | "BEACON" | "CUSTOM" | "UNKNOWN";
  readonly implementationAddress: Knowledge<Address>;
  readonly implementationCodeHash: Knowledge<Hex32>;
  readonly adminAddress: Knowledge<Address>;
  readonly launchEventTopic: Hex32;
  readonly eventAbiHash: Hex32;
  readonly adapterIds: Readonly<{
    factory: string;
    poolRead: string;
    entry: string;
    exit: string;
    finalize: string;
  }>;
  readonly quoteAssets: readonly Address[];
  readonly lifecycle: readonly ("LAUNCH" | "ACTIVE_SALE" | "FINALIZED" | "EXTERNAL_AMM")[];
  readonly state: FactoryProfileState;
  readonly evidenceIds: readonly Id[];
  readonly lastVerifiedBlock: DecimalString;
  readonly configHash: string;
  readonly createdAt: IsoTimestamp;
}

export interface LaunchCandidate {
  readonly candidateId: Id;
  readonly strategyId: string;
  readonly revision: number;
  readonly factoryProfileId: Id;
  readonly creator: Address;
  readonly tokenAddress: Address;
  readonly poolAddress: Address;
  readonly name: string;
  readonly symbol: string;
  readonly metadataUri: string;
  readonly imageHash: Hex32;
  readonly blockNumber: DecimalString;
  readonly blockHash: Hex32;
  readonly transactionHash: Hex32;
  readonly transactionIndex: DecimalString;
  readonly logIndex: DecimalString;
  readonly evidenceIds: readonly Id[];
  readonly observedAt: IsoTimestamp;
}

export interface LaunchIdentity extends LaunchCandidate {
  readonly launchId: Id;
  readonly tokenRuntimeCodeHash: Hex32;
  readonly poolRuntimeCodeHash: Hex32;
  readonly mechanismProfileId: Id;
  readonly identityPolicyHash: string;
  readonly configHash: string;
  readonly frozenAt: IsoTimestamp;
  readonly state: "FROZEN" | "IDENTITY_CONFLICT" | "REORG_RECONCILE";
}

export interface Opportunity {
  readonly opportunityId: Id;
  readonly strategyId: string;
  readonly revision: number;
  readonly launchId: Id;
  readonly targetKey: string;
  readonly validityEnvelopeId: Id;
  readonly status: "DISCOVERED" | "ENRICHING" | "READY" | "REJECTED" | "EXPIRED";
  readonly evidenceIds: readonly Id[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface BoundaryConstraint {
  readonly constraintId: Id;
  readonly basis: "TIME" | "BLOCK" | "STATE";
  readonly origin: string;
  readonly absoluteValue: string;
  readonly evidenceIds: readonly Id[];
}

export interface ValidityEnvelope {
  readonly envelopeId: Id;
  readonly strategyId: string;
  readonly revision: number;
  readonly chainId: number;
  readonly activation?: BoundaryConstraint;
  readonly invalidation: readonly BoundaryConstraint[];
  readonly factoryProfileRevision: number;
  readonly mechanismProfileRevision: number;
  readonly quoteBlock?: DecimalString;
  readonly maxPrincipalRaw: DecimalString;
  readonly minOutputRaw?: DecimalString;
  readonly evidenceIds: readonly Id[];
  readonly createdAt: IsoTimestamp;
}

export interface AuthorizationRecord {
  readonly authorizationId: Id;
  readonly strategyId: string;
  readonly revision: number;
  readonly level: "L0" | "L1" | "L2" | "L3" | "L4";
  readonly mode: "AUTO_POLICY" | "MANUAL_ARM" | "BREAK_GLASS";
  readonly actorRef: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly scopeHash: string;
  readonly riskEnvelopeHash: string;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly evidenceIds: readonly Id[];
  readonly reason: string;
}

export interface StrategyBudget {
  readonly budgetId: Id;
  readonly strategyId: string;
  readonly revision: number;
  readonly launchId: Id;
  readonly configHash: string;
  readonly nominalUnit: "USD_MICROS";
  readonly principalLimit: DecimalString;
  readonly evidenceIds: readonly Id[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export type ReservationState =
  | "RESERVED"
  | "SIGNED"
  | "BROADCAST"
  | "UNKNOWN"
  | "SPENT"
  | "RELEASED"
  | "EXPIRED";

export interface CapitalReservation {
  readonly reservationId: Id;
  readonly strategyId: string;
  readonly revision: number;
  readonly budgetId: Id;
  readonly launchId: Id;
  readonly laneId: Id;
  readonly intentId: Id;
  readonly configHash: string;
  readonly principalRaw: DecimalString;
  readonly state: ReservationState;
  readonly evidenceIds: readonly Id[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface WalletLane {
  readonly laneId: Id;
  readonly strategyId: string;
  readonly revision: number;
  readonly walletId: Id;
  readonly address: Address;
  readonly role: "CLOCKIN_ENTRY" | "FIRST_LAUNCH_CANARY" | "MICRO_PROBE";
  readonly trancheNumber: number;
  readonly maxPrincipalRaw: DecimalString;
  readonly evidenceIds: readonly Id[];
  readonly state:
    | "UNALLOCATED"
    | "CAPITAL_RESERVED"
    | "IDENTITY_ELIGIBLE"
    | "FEE_ELIGIBLE"
    | "PLAN_FROZEN"
    | "SIGNED"
    | "BROADCASTING"
    | "UNKNOWN"
    | "EFFECT_CONFIRMED"
    | "FAILED_FINAL"
    | "EXPIRED";
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

interface BaseIntent {
  readonly intentId: Id;
  readonly strategyId: string;
  readonly revision: number;
  readonly opportunityId: Id;
  readonly launchId: Id;
  readonly laneId: Id;
  readonly validityEnvelopeId: Id;
  readonly targetKey: string;
  readonly maxInputRaw: DecimalString;
  readonly minOutputRaw?: DecimalString;
  readonly authorizationId: Id;
  readonly evidenceIds: readonly Id[];
  readonly createdAt: IsoTimestamp;
}

export interface EntryIntent extends BaseIntent {
  readonly side: "ENTRY";
  readonly action: "BUY" | "PROBE";
  readonly trancheNumber: number;
}

export interface ExitIntent extends BaseIntent {
  readonly side: "EXIT";
  readonly action: "SELL" | "SWAP" | "EXIT_NOW";
  readonly positionLotId: Id;
}

export type CanonicalIntent = EntryIntent | ExitIntent;

export interface ExecutionPlan {
  readonly planId: Id;
  readonly planHash: string;
  readonly strategyId: string;
  readonly revision: number;
  readonly intentId: Id;
  readonly launchId: Id;
  readonly laneId: Id;
  readonly validityEnvelopeId: Id;
  readonly authorizationId: Id;
  readonly factoryProfileRevision: number;
  readonly mechanismProfileRevision: number;
  readonly adapterId: string;
  readonly walletAddress: Address;
  readonly nonce: DecimalString;
  readonly to: Address;
  readonly valueRaw: DecimalString;
  readonly calldataHash: string;
  readonly methodSelector: `0x${string}`;
  readonly observedFeeBps: number;
  readonly targetFeeBps: number;
  readonly quoteBlock: DecimalString;
  readonly minOutputRaw: DecimalString;
  readonly gasLimit: DecimalString;
  readonly maxFeePerGasRaw: DecimalString;
  readonly maxPriorityFeePerGasRaw: DecimalString;
  readonly capitalReservationId: Id;
  readonly evidenceIds: readonly Id[];
  readonly state:
    | "DRAFT"
    | "VALIDATED"
    | "RESERVED"
    | "FROZEN"
    | "SIGNED"
    | "INVALIDATED"
    | "EXPIRED";
  readonly createdAt: IsoTimestamp;
  readonly frozenAt?: IsoTimestamp;
}

export interface TransportEvent {
  readonly routeId: string;
  readonly startedAt: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly result: "ACCEPTED" | "KNOWN" | "REJECTED" | "TIMEOUT" | "ERROR";
  readonly latencyMs?: number;
  readonly evidenceId: Id;
}

export interface TxAttempt {
  readonly attemptId: Id;
  readonly strategyId: string;
  readonly revision: number;
  readonly intentId: Id;
  readonly planId: Id;
  readonly launchId: Id;
  readonly laneId: Id;
  readonly walletAddress: Address;
  readonly nonce: DecimalString;
  readonly operation: "INITIAL" | "REPLACE_SAME_NONCE" | "CANCEL_SAME_NONCE";
  readonly signedTxHash: Hex32;
  readonly payloadHash: string;
  readonly vaultRef?: string;
  readonly transportEvents: readonly TransportEvent[];
  readonly state:
    | "PREPARED"
    | "SIGNED"
    | "BROADCASTING"
    | "ACCEPTED"
    | "UNKNOWN"
    | "INCLUDED"
    | "CONFIRMED_SUCCESS"
    | "CONFIRMED_REVERTED"
    | "DROPPED_PROVEN"
    | "EXPIRED_UNRESOLVED";
  readonly evidenceIds: readonly Id[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface AssetDelta {
  readonly asset: Address;
  readonly account: Address;
  readonly amountRaw: DecimalString;
}

export interface EffectRecord {
  readonly effectId: Id;
  readonly strategyId: string;
  readonly revision: number;
  readonly intentId: Id;
  readonly attemptId: Id;
  readonly launchId: Id;
  readonly laneId: Id;
  readonly side: "ENTRY" | "EXIT";
  readonly result:
    | "SUCCESS"
    | "REVERTED"
    | "SUCCESS_NO_TOKENS"
    | "PARTIAL"
    | "UNKNOWN"
    | "DISPUTED";
  readonly canonicality: "CANONICAL" | "PROVISIONAL" | "REORGED" | "UNKNOWN";
  readonly txHash: Hex32;
  readonly blockNumber: Knowledge<DecimalString>;
  readonly blockHash: Knowledge<Hex32>;
  readonly transactionIndex: Knowledge<DecimalString>;
  readonly assetDeltas: Knowledge<readonly AssetDelta[]>;
  readonly principalDeltaRaw: Knowledge<DecimalString>;
  readonly tokenDeltaRaw: Knowledge<DecimalString>;
  readonly gasCostRaw: Knowledge<DecimalString>;
  readonly declaredFeeBps: Knowledge<number>;
  readonly actualOutputRaw: Knowledge<DecimalString>;
  readonly settlement: "FLAT" | "RESIDUAL_POSITION" | "FAILED" | "UNKNOWN";
  readonly positionLotIds: readonly Id[];
  readonly evidenceIds: readonly Id[];
  readonly observedAt: IsoTimestamp;
}

export interface PositionLot {
  readonly lotId: Id;
  readonly strategyId: string;
  readonly revision: number;
  readonly launchId: Id;
  readonly laneId: Id;
  readonly walletAddress: Address;
  readonly tokenAddress: Address;
  readonly quantityRaw: DecimalString;
  readonly remainingRaw: DecimalString;
  readonly principalCostRaw: DecimalString;
  readonly entryGasCostRaw: DecimalString;
  readonly buyFrictionRaw: Knowledge<DecimalString>;
  readonly entryRouteId: Id;
  readonly entryNonce: Knowledge<DecimalString>;
  readonly allowanceRaw: Knowledge<DecimalString>;
  readonly pendingNonce: Knowledge<DecimalString>;
  readonly declaredFeeBps: Knowledge<number>;
  readonly originEffectId: Id;
  readonly state: "OPEN" | "PARTIALLY_EXITED" | "EXIT_PENDING" | "CLOSED" | "UNKNOWN";
  readonly evidenceIds: readonly Id[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface AggregatePosition {
  readonly positionId: Id;
  readonly strategyId: string;
  readonly revision: number;
  readonly launchId: Id;
  readonly tokenAddress: Address;
  readonly lotIds: readonly Id[];
  readonly totalQuantityRaw: DecimalString;
  readonly remainingQuantityRaw: DecimalString;
  readonly totalActualCostRaw: DecimalString;
  readonly realizedProceedsRaw: DecimalString;
  readonly executableNetLiquidationRaw: Knowledge<DecimalString>;
  readonly state: "OPEN" | "PARTIALLY_EXITED" | "CLOSED" | "UNKNOWN";
  readonly evidenceIds: readonly Id[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface RouteQuote {
  readonly quoteId: Id;
  readonly strategyId: string;
  readonly revision: number;
  readonly launchId: Id;
  readonly lotId: Id;
  readonly routeId: Id;
  readonly routeKind: "LAUNCH_POOL" | "EXTERNAL_AMM";
  readonly tokenInputRaw: DecimalString;
  readonly grossOutputRaw: DecimalString;
  readonly sellTaxRaw: DecimalString;
  readonly priceImpactRaw: DecimalString;
  readonly approvalGasRaw: DecimalString;
  readonly executionGasRaw: DecimalString;
  readonly netOutputRaw: DecimalString;
  readonly quoteBlock: DecimalString;
  readonly observedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly evidenceIds: readonly Id[];
}

export interface ExitPlan {
  readonly exitPlanId: Id;
  readonly strategyId: string;
  readonly revision: number;
  readonly launchId: Id;
  readonly positionId: Id;
  readonly lotId: Id;
  readonly policyStage:
    | "RECOVER_PRINCIPAL"
    | "TAKE_SECOND_PROFIT"
    | "RUNNER"
    | "DUST_CLOSE"
    | "EXIT_NOW";
  readonly routeQuoteId: Id;
  readonly tokenInputRaw: DecimalString;
  readonly minOutputRaw: DecimalString;
  readonly validityEnvelopeId: Id;
  readonly state:
    | "DRAFT"
    | "ARMED"
    | "DUE"
    | "EXECUTING"
    | "UNKNOWN"
    | "PARTIALLY_COMPLETED"
    | "COMPLETED"
    | "FAILED_RECOVERABLE";
  readonly evidenceIds: readonly Id[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ExitEffectRecord extends EffectRecord {
  readonly side: "EXIT";
  readonly exitPlanId: Id;
  readonly quoteProceedsDeltaRaw: Knowledge<DecimalString>;
}

export type ReasonCode =
  | "FACTORY_CODE_DRIFT"
  | "IDENTITY_INCOMPLETE"
  | "IDENTITY_CONFLICT"
  | "AUTHORIZATION_EXPIRED"
  | "AUTHORIZATION_SCOPE_MISMATCH"
  | "PROFILE_UNSUPPORTED"
  | "PROFILE_STALE"
  | "EVIDENCE_INCOMPLETE"
  | "MECHANISM_GETTER_ERROR"
  | "POOL_STATE_INVALID"
  | "QUOTE_STALE"
  | "CAP_EXCEEDED"
  | "COOLDOWN_ACTIVE"
  | "EOA_ONLY_REQUIRED"
  | "BUDGET_EXCEEDED"
  | "NONCE_CONFLICT"
  | "TRANSPORT_UNKNOWN"
  | "RECEIPT_REVERTED"
  | "SUCCESS_NO_TOKENS"
  | "REORG_DETECTED"
  | "ROUTE_UNAVAILABLE"
  | "LIQUIDITY_ZERO"
  | "STATE_TRANSITION_INVALID";

export class CanonicalInvariantError extends Error {
  readonly reasonCode: ReasonCode;

  constructor(reasonCode: ReasonCode, message: string) {
    super(message);
    this.name = "CanonicalInvariantError";
    this.reasonCode = reasonCode;
  }
}

export function assertDecimalString(name: string, value: string): asserts value is DecimalString {
  if (!/^(0|[1-9][0-9]*|-?[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${name} must be a canonical base-10 integer string`);
  }
}

export function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function stableHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function isAuthorizationUsable(
  authorization: AuthorizationRecord,
  expectedScopeHash: string,
  expectedRiskEnvelopeHash: string,
  now: IsoTimestamp,
): boolean {
  return (
    authorization.scopeHash === expectedScopeHash &&
    authorization.riskEnvelopeHash === expectedRiskEnvelopeHash &&
    (authorization.expiresAt === undefined || authorization.expiresAt > now)
  );
}
