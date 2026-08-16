import { CanonicalInvariantError, stableHash } from "../core/canonical.js";
import type { EntryTransactionTemplate } from "../adapters/protocol-contracts.js";
import type { PoolObservation } from "./pool-observation.js";

export interface PreparedCanary {
  readonly preparationId: string;
  readonly observation: PoolObservation;
  readonly template: EntryTransactionTemplate;
  readonly signedRaw: `0x${string}`;
  readonly earliestValidBlock: bigint;
}

export async function prepareCanaryInParallel(input: {
  readonly identityLevel: "L0" | "L1" | "L2" | "L3" | "L4";
  readonly launchBlock: bigint;
  readonly readPreflight: () => Promise<PoolObservation>;
  readonly buildAndSign: () => Promise<
    Readonly<{ template: EntryTransactionTemplate; signedRaw: `0x${string}` }>
  >;
}): Promise<PreparedCanary> {
  if (
    input.identityLevel !== "L2" &&
    input.identityLevel !== "L3" &&
    input.identityLevel !== "L4"
  ) {
    throw new CanonicalInvariantError("IDENTITY_INCOMPLETE", "canary preparation requires L2");
  }
  const [observation, signed] = await Promise.all([input.readPreflight(), input.buildAndSign()]);
  const earliestValidBlock = input.launchBlock + 1n;
  if (signed.template.earliestValidBlock !== earliestValidBlock) {
    throw new CanonicalInvariantError(
      "STATE_TRANSITION_INVALID",
      "entry template does not bind the earliest legal external block",
    );
  }
  if (observation.block.blockNumber < input.launchBlock) {
    throw new CanonicalInvariantError(
      "STATE_TRANSITION_INVALID",
      "dynamic preflight predates the frozen launch block",
    );
  }
  return Object.freeze({
    preparationId: `canary-preparation:${stableHash({
      observationId: observation.observationId,
      adapterId: signed.template.adapterId,
      earliestValidBlock: earliestValidBlock.toString(),
    })}`,
    observation,
    template: signed.template,
    signedRaw: signed.signedRaw,
    earliestValidBlock,
  });
}
