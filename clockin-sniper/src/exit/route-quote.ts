import { stableHash, type IsoTimestamp, type RouteQuote } from "../core/canonical.js";

export function createNetRouteQuote(input: {
  strategyId: string;
  launchId: string;
  revision: number;
  lotId: string;
  routeId: string;
  routeKind: RouteQuote["routeKind"];
  tokenInputRaw: bigint;
  grossOutputRaw: bigint;
  sellTaxRaw: bigint;
  priceImpactRaw: bigint;
  approvalGasRaw: bigint;
  executionGasRaw: bigint;
  quoteBlock: bigint;
  observedAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  evidenceIds: readonly string[];
}): RouteQuote {
  for (const [name, value] of Object.entries({
    tokenInputRaw: input.tokenInputRaw,
    grossOutputRaw: input.grossOutputRaw,
    sellTaxRaw: input.sellTaxRaw,
    priceImpactRaw: input.priceImpactRaw,
    approvalGasRaw: input.approvalGasRaw,
    executionGasRaw: input.executionGasRaw,
    quoteBlock: input.quoteBlock,
  })) {
    if (value < 0n) throw new RangeError(`${name} cannot be negative`);
  }
  if (input.tokenInputRaw <= 0n) throw new RangeError("route quote token input must be positive");
  if (input.expiresAt < input.observedAt)
    throw new RangeError("route quote expires before observation");
  const deductions =
    input.sellTaxRaw + input.priceImpactRaw + input.approvalGasRaw + input.executionGasRaw;
  const netOutputRaw = input.grossOutputRaw > deductions ? input.grossOutputRaw - deductions : 0n;
  const quoteId = `route-quote:${stableHash({
    ...input,
    tokenInputRaw: input.tokenInputRaw.toString(),
    grossOutputRaw: input.grossOutputRaw.toString(),
    sellTaxRaw: input.sellTaxRaw.toString(),
    priceImpactRaw: input.priceImpactRaw.toString(),
    approvalGasRaw: input.approvalGasRaw.toString(),
    executionGasRaw: input.executionGasRaw.toString(),
    quoteBlock: input.quoteBlock.toString(),
  })}`;
  return Object.freeze({
    quoteId,
    strategyId: input.strategyId,
    revision: input.revision,
    launchId: input.launchId,
    lotId: input.lotId,
    routeId: input.routeId,
    routeKind: input.routeKind,
    tokenInputRaw: input.tokenInputRaw.toString(),
    grossOutputRaw: input.grossOutputRaw.toString(),
    sellTaxRaw: input.sellTaxRaw.toString(),
    priceImpactRaw: input.priceImpactRaw.toString(),
    approvalGasRaw: input.approvalGasRaw.toString(),
    executionGasRaw: input.executionGasRaw.toString(),
    netOutputRaw: netOutputRaw.toString(),
    quoteBlock: input.quoteBlock.toString(),
    observedAt: input.observedAt,
    expiresAt: input.expiresAt,
    evidenceIds: Object.freeze([...input.evidenceIds]),
  });
}

export function selectBestExecutableRoute(
  quotes: readonly RouteQuote[],
  now: IsoTimestamp,
): RouteQuote | null {
  const valid = quotes.filter((quote) => quote.expiresAt >= now && BigInt(quote.netOutputRaw) > 0n);
  valid.sort((left, right) => {
    const leftNet = BigInt(left.netOutputRaw);
    const rightNet = BigInt(right.netOutputRaw);
    if (leftNet !== rightNet) return leftNet > rightNet ? -1 : 1;
    return (
      right.expiresAt.localeCompare(left.expiresAt) || left.routeId.localeCompare(right.routeId)
    );
  });
  return valid[0] ?? null;
}
