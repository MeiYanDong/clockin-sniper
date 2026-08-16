import {
  stableHash,
  type Address,
  type AssetDelta,
  type EffectRecord,
  type Hex32,
  type IsoTimestamp,
  type Knowledge,
  type PositionLot,
} from "../core/canonical.js";

export interface EntryReceiptEvidence {
  readonly strategyId: string;
  readonly intentId: string;
  readonly attemptId: string;
  readonly launchId: string;
  readonly laneId: string;
  readonly walletAddress: Address;
  readonly tokenAddress: Address;
  readonly principalAsset: Address;
  readonly principalAssetKind: "NATIVE" | "ERC20";
  readonly entryRouteId: string;
  readonly entryNonce?: bigint;
  readonly expectedSignedTxHash: Hex32;
  readonly receiptTxHash: Hex32;
  readonly receiptStatus: 0 | 1;
  readonly blockNumber: bigint;
  readonly blockHash: Hex32;
  readonly transactionIndex: bigint;
  readonly gasUsed: bigint;
  readonly effectiveGasPriceRaw: bigint;
  readonly principalBalanceBeforeRaw: bigint;
  readonly principalBalanceAfterRaw: bigint;
  readonly tokenBalanceBeforeRaw: bigint;
  readonly tokenBalanceAfterRaw: bigint;
  readonly transferLogTokenOutRaw: bigint;
  readonly plannedPrincipalRaw: bigint;
  readonly declaredFeeBps?: number;
  readonly evidenceIds: readonly string[];
  readonly observedAt: IsoTimestamp;
  readonly finality: "PROVISIONAL" | "CANONICAL";
}

export interface EntryEffectBuildResult {
  readonly effect: EffectRecord;
  readonly positionLot?: PositionLot;
  readonly principalSpentRaw: bigint;
  readonly principalRefundRaw: bigint;
  readonly tokenBalanceDeltaRaw: bigint;
  readonly transferLogTokenOutRaw: bigint;
  readonly gasCostRaw: bigint;
}

function known<T>(value: T, evidence: EntryReceiptEvidence): Knowledge<T> {
  return Object.freeze({
    state: "KNOWN",
    value,
    observedAt: evidence.observedAt,
    evidenceIds: Object.freeze([...evidence.evidenceIds]),
  });
}

function validateEvidence(evidence: EntryReceiptEvidence): void {
  for (const [name, value] of Object.entries({
    blockNumber: evidence.blockNumber,
    transactionIndex: evidence.transactionIndex,
    gasUsed: evidence.gasUsed,
    effectiveGasPriceRaw: evidence.effectiveGasPriceRaw,
    principalBalanceBeforeRaw: evidence.principalBalanceBeforeRaw,
    principalBalanceAfterRaw: evidence.principalBalanceAfterRaw,
    tokenBalanceBeforeRaw: evidence.tokenBalanceBeforeRaw,
    tokenBalanceAfterRaw: evidence.tokenBalanceAfterRaw,
    transferLogTokenOutRaw: evidence.transferLogTokenOutRaw,
    plannedPrincipalRaw: evidence.plannedPrincipalRaw,
  })) {
    if (value < 0n) throw new RangeError(`${name} cannot be negative`);
  }
  if (
    evidence.declaredFeeBps !== undefined &&
    (!Number.isSafeInteger(evidence.declaredFeeBps) ||
      evidence.declaredFeeBps < 0 ||
      evidence.declaredFeeBps > 10_000)
  ) {
    throw new RangeError("declaredFeeBps must be in 0..10000");
  }
  if (evidence.receiptTxHash.toLowerCase() !== evidence.expectedSignedTxHash.toLowerCase()) {
    throw new Error("receipt txHash does not match the signed transaction hash");
  }
}

export function buildEntryEffect(evidence: EntryReceiptEvidence): EntryEffectBuildResult {
  validateEvidence(evidence);
  const gasCostRaw = evidence.gasUsed * evidence.effectiveGasPriceRaw;
  const principalWalletDelta =
    evidence.principalBalanceBeforeRaw - evidence.principalBalanceAfterRaw;
  const rawPrincipalSpent =
    evidence.principalAssetKind === "NATIVE"
      ? principalWalletDelta - gasCostRaw
      : principalWalletDelta;
  const principalSpentRaw = rawPrincipalSpent > 0n ? rawPrincipalSpent : 0n;
  const principalRefundRaw =
    evidence.plannedPrincipalRaw > principalSpentRaw
      ? evidence.plannedPrincipalRaw - principalSpentRaw
      : 0n;
  const tokenBalanceDeltaRaw = evidence.tokenBalanceAfterRaw - evidence.tokenBalanceBeforeRaw;
  const positiveTokenDelta = tokenBalanceDeltaRaw > 0n ? tokenBalanceDeltaRaw : 0n;
  const deliveryAgrees = positiveTokenDelta === evidence.transferLogTokenOutRaw;

  const result: EffectRecord["result"] =
    evidence.receiptStatus === 0
      ? "REVERTED"
      : positiveTokenDelta === 0n
        ? "SUCCESS_NO_TOKENS"
        : deliveryAgrees
          ? "SUCCESS"
          : "DISPUTED";
  const effectId = `entry-effect:${stableHash({
    attemptId: evidence.attemptId,
    txHash: evidence.receiptTxHash,
    blockHash: evidence.blockHash,
    tokenBalanceDeltaRaw: tokenBalanceDeltaRaw.toString(),
    transferLogTokenOutRaw: evidence.transferLogTokenOutRaw.toString(),
  })}`;
  const lotId = `position-lot:${stableHash({ effectId, walletAddress: evidence.walletAddress })}`;
  const assetDeltas: readonly AssetDelta[] = Object.freeze([
    Object.freeze({
      asset: evidence.principalAsset,
      account: evidence.walletAddress,
      amountRaw: (-principalSpentRaw).toString(),
    }),
    Object.freeze({
      asset: evidence.tokenAddress,
      account: evidence.walletAddress,
      amountRaw: positiveTokenDelta.toString(),
    }),
  ]);
  const effect: EffectRecord = Object.freeze({
    effectId,
    strategyId: evidence.strategyId,
    revision: 1,
    intentId: evidence.intentId,
    attemptId: evidence.attemptId,
    launchId: evidence.launchId,
    laneId: evidence.laneId,
    side: "ENTRY",
    result,
    canonicality: evidence.finality,
    txHash: evidence.receiptTxHash,
    blockNumber: known(evidence.blockNumber.toString(), evidence),
    blockHash: known(evidence.blockHash, evidence),
    transactionIndex: known(evidence.transactionIndex.toString(), evidence),
    assetDeltas: known(assetDeltas, evidence),
    principalDeltaRaw: known((-principalSpentRaw).toString(), evidence),
    tokenDeltaRaw: known(positiveTokenDelta.toString(), evidence),
    gasCostRaw: known(gasCostRaw.toString(), evidence),
    declaredFeeBps:
      evidence.declaredFeeBps === undefined
        ? Object.freeze({
            state: "UNKNOWN",
            reason: "declared fee was not captured in the bound plan",
            since: evidence.observedAt,
          })
        : known(evidence.declaredFeeBps, evidence),
    actualOutputRaw: known(positiveTokenDelta.toString(), evidence),
    settlement: result === "SUCCESS" ? "RESIDUAL_POSITION" : "FAILED",
    positionLotIds: result === "SUCCESS" ? Object.freeze([lotId]) : Object.freeze([]),
    evidenceIds: Object.freeze([...evidence.evidenceIds]),
    observedAt: evidence.observedAt,
  });

  const positionLot: PositionLot | undefined =
    result !== "SUCCESS"
      ? undefined
      : Object.freeze({
          lotId,
          strategyId: evidence.strategyId,
          revision: 1,
          launchId: evidence.launchId,
          laneId: evidence.laneId,
          walletAddress: evidence.walletAddress,
          tokenAddress: evidence.tokenAddress,
          quantityRaw: positiveTokenDelta.toString(),
          remainingRaw: positiveTokenDelta.toString(),
          principalCostRaw: principalSpentRaw.toString(),
          entryGasCostRaw: gasCostRaw.toString(),
          buyFrictionRaw: Object.freeze({
            state: "UNKNOWN",
            reason: "buy-side friction decomposition requires a verified no-fee adapter reference",
            since: evidence.observedAt,
          }),
          entryRouteId: evidence.entryRouteId,
          entryNonce:
            evidence.entryNonce === undefined
              ? Object.freeze({
                  state: "UNKNOWN" as const,
                  reason: "entry nonce was not captured in legacy receipt evidence",
                  since: evidence.observedAt,
                })
              : known(evidence.entryNonce.toString(), evidence),
          allowanceRaw: Object.freeze({
            state: "UNKNOWN" as const,
            reason: "token allowance requires a current wallet-level chain read",
            since: evidence.observedAt,
          }),
          pendingNonce: Object.freeze({
            state: "UNKNOWN" as const,
            reason: "pending nonce requires a post-receipt wallet read",
            since: evidence.observedAt,
          }),
          declaredFeeBps:
            evidence.declaredFeeBps === undefined
              ? Object.freeze({
                  state: "UNKNOWN",
                  reason: "declared fee was not captured in the bound plan",
                  since: evidence.observedAt,
                })
              : known(evidence.declaredFeeBps, evidence),
          originEffectId: effectId,
          state: "OPEN",
          evidenceIds: Object.freeze([...evidence.evidenceIds]),
          createdAt: evidence.observedAt,
          updatedAt: evidence.observedAt,
        });

  return Object.freeze({
    effect,
    ...(positionLot === undefined ? {} : { positionLot }),
    principalSpentRaw,
    principalRefundRaw,
    tokenBalanceDeltaRaw,
    transferLogTokenOutRaw: evidence.transferLogTokenOutRaw,
    gasCostRaw,
  });
}
