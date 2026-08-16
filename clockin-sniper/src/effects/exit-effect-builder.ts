import {
  stableHash,
  type Address,
  type AssetDelta,
  type ExitEffectRecord,
  type Hex32,
  type IsoTimestamp,
  type Knowledge,
  type PositionLot,
} from "../core/canonical.js";

export interface ExitReceiptEvidence {
  readonly strategyId: string;
  readonly intentId: string;
  readonly attemptId: string;
  readonly exitPlanId: string;
  readonly launchId: string;
  readonly laneId: string;
  readonly lot: PositionLot;
  readonly quoteAsset: Address;
  readonly expectedSignedTxHash: Hex32;
  readonly receiptTxHash: Hex32;
  readonly receiptStatus: 0 | 1;
  readonly blockNumber: bigint;
  readonly blockHash: Hex32;
  readonly transactionIndex: bigint;
  readonly gasUsed: bigint;
  readonly effectiveGasPriceRaw: bigint;
  readonly tokenBalanceBeforeRaw: bigint;
  readonly tokenBalanceAfterRaw: bigint;
  readonly quoteBalanceBeforeRaw: bigint;
  readonly quoteBalanceAfterRaw: bigint;
  readonly expectedTokenInputRaw: bigint;
  readonly evidenceIds: readonly string[];
  readonly observedAt: IsoTimestamp;
  readonly finality: "PROVISIONAL" | "CANONICAL";
}

export interface ExitEffectBuildResult {
  readonly effect: ExitEffectRecord;
  readonly revisedLot: PositionLot;
  readonly actualTokenSpentRaw: bigint;
  readonly actualQuoteProceedsRaw: bigint;
  readonly gasCostRaw: bigint;
}

function known<T>(value: T, evidence: ExitReceiptEvidence): Knowledge<T> {
  return Object.freeze({
    state: "KNOWN",
    value,
    observedAt: evidence.observedAt,
    evidenceIds: Object.freeze([...evidence.evidenceIds]),
  });
}

export function buildExitEffect(evidence: ExitReceiptEvidence): ExitEffectBuildResult {
  if (evidence.receiptTxHash.toLowerCase() !== evidence.expectedSignedTxHash.toLowerCase()) {
    throw new Error("exit receipt txHash does not match the signed transaction hash");
  }
  for (const [name, value] of Object.entries({
    blockNumber: evidence.blockNumber,
    transactionIndex: evidence.transactionIndex,
    gasUsed: evidence.gasUsed,
    effectiveGasPriceRaw: evidence.effectiveGasPriceRaw,
    tokenBalanceBeforeRaw: evidence.tokenBalanceBeforeRaw,
    tokenBalanceAfterRaw: evidence.tokenBalanceAfterRaw,
    quoteBalanceBeforeRaw: evidence.quoteBalanceBeforeRaw,
    quoteBalanceAfterRaw: evidence.quoteBalanceAfterRaw,
    expectedTokenInputRaw: evidence.expectedTokenInputRaw,
  })) {
    if (value < 0n) throw new RangeError(`${name} cannot be negative`);
  }
  const gasCostRaw = evidence.gasUsed * evidence.effectiveGasPriceRaw;
  const tokenSpentDelta = evidence.tokenBalanceBeforeRaw - evidence.tokenBalanceAfterRaw;
  const quoteProceedsDelta = evidence.quoteBalanceAfterRaw - evidence.quoteBalanceBeforeRaw;
  const actualTokenSpentRaw =
    evidence.receiptStatus === 1 && tokenSpentDelta > 0n ? tokenSpentDelta : 0n;
  const actualQuoteProceedsRaw =
    evidence.receiptStatus === 1 && quoteProceedsDelta > 0n ? quoteProceedsDelta : 0n;
  const result: ExitEffectRecord["result"] =
    evidence.receiptStatus === 0
      ? "REVERTED"
      : actualTokenSpentRaw === 0n || actualQuoteProceedsRaw === 0n
        ? "DISPUTED"
        : actualTokenSpentRaw > evidence.expectedTokenInputRaw
          ? "DISPUTED"
          : actualTokenSpentRaw < evidence.expectedTokenInputRaw
            ? "PARTIAL"
            : "SUCCESS";
  const effectId = `exit-effect:${stableHash({
    attemptId: evidence.attemptId,
    exitPlanId: evidence.exitPlanId,
    txHash: evidence.receiptTxHash,
    blockHash: evidence.blockHash,
    actualTokenSpentRaw: actualTokenSpentRaw.toString(),
    actualQuoteProceedsRaw: actualQuoteProceedsRaw.toString(),
  })}`;
  const assetDeltas: readonly AssetDelta[] = Object.freeze([
    Object.freeze({
      asset: evidence.lot.tokenAddress,
      account: evidence.lot.walletAddress,
      amountRaw: (-actualTokenSpentRaw).toString(),
    }),
    Object.freeze({
      asset: evidence.quoteAsset,
      account: evidence.lot.walletAddress,
      amountRaw: actualQuoteProceedsRaw.toString(),
    }),
  ]);
  const remainingRaw =
    actualTokenSpentRaw > BigInt(evidence.lot.remainingRaw)
      ? BigInt(evidence.lot.remainingRaw)
      : BigInt(evidence.lot.remainingRaw) - actualTokenSpentRaw;
  const revisedLot: PositionLot = Object.freeze({
    ...evidence.lot,
    revision: evidence.lot.revision + 1,
    remainingRaw: remainingRaw.toString(),
    state:
      result === "DISPUTED"
        ? "UNKNOWN"
        : remainingRaw === 0n
          ? "CLOSED"
          : actualTokenSpentRaw > 0n
            ? "PARTIALLY_EXITED"
            : evidence.lot.state,
    evidenceIds: Object.freeze([...evidence.lot.evidenceIds, ...evidence.evidenceIds]),
    updatedAt: evidence.observedAt,
  });
  const effect: ExitEffectRecord = Object.freeze({
    effectId,
    strategyId: evidence.strategyId,
    revision: 1,
    intentId: evidence.intentId,
    attemptId: evidence.attemptId,
    launchId: evidence.launchId,
    laneId: evidence.laneId,
    side: "EXIT",
    exitPlanId: evidence.exitPlanId,
    result,
    canonicality: evidence.finality,
    txHash: evidence.receiptTxHash,
    blockNumber: known(evidence.blockNumber.toString(), evidence),
    blockHash: known(evidence.blockHash, evidence),
    transactionIndex: known(evidence.transactionIndex.toString(), evidence),
    assetDeltas: known(assetDeltas, evidence),
    principalDeltaRaw: known(actualQuoteProceedsRaw.toString(), evidence),
    tokenDeltaRaw: known((-actualTokenSpentRaw).toString(), evidence),
    gasCostRaw: known(gasCostRaw.toString(), evidence),
    declaredFeeBps: Object.freeze({
      state: "UNKNOWN",
      reason: "sell fee decomposition belongs to the bound route quote",
      since: evidence.observedAt,
    }),
    actualOutputRaw: known(actualQuoteProceedsRaw.toString(), evidence),
    quoteProceedsDeltaRaw: known(actualQuoteProceedsRaw.toString(), evidence),
    settlement:
      remainingRaw === 0n ? "FLAT" : result === "REVERTED" ? "FAILED" : "RESIDUAL_POSITION",
    positionLotIds: Object.freeze([evidence.lot.lotId]),
    evidenceIds: Object.freeze([...evidence.evidenceIds]),
    observedAt: evidence.observedAt,
  });
  return Object.freeze({
    effect,
    revisedLot,
    actualTokenSpentRaw,
    actualQuoteProceedsRaw,
    gasCostRaw,
  });
}
