import { stableHash } from "../core/canonical.js";

export type CapabilityEvidence =
  | "UNSUPPORTED"
  | "PLANNED"
  | "SUPPORTED"
  | "TESTED"
  | "VERIFIED_CURRENT";

export interface ProtocolAdapterCapabilities {
  readonly adapterId: string;
  readonly revision: number;
  readonly identity: CapabilityEvidence;
  readonly poolState: CapabilityEvidence;
  readonly entryQuote: CapabilityEvidence;
  readonly entryCalldata: CapabilityEvidence;
  readonly sellQuote: CapabilityEvidence;
  readonly sellCalldata: CapabilityEvidence;
  readonly finalizeDetection: CapabilityEvidence;
  readonly liveReceiptEvidence: CapabilityEvidence;
  readonly evidenceIds: readonly string[];
}

export interface CapabilityManifestRecord extends ProtocolAdapterCapabilities {
  readonly manifestHash: string;
  readonly generatedAt: string;
}

export function createCapabilityManifest(
  capabilities: ProtocolAdapterCapabilities,
  generatedAt: string,
): CapabilityManifestRecord {
  return Object.freeze({
    ...capabilities,
    evidenceIds: Object.freeze([...capabilities.evidenceIds]),
    manifestHash: stableHash(capabilities),
    generatedAt,
  });
}

export function assertAdapterHotArmable(
  manifest: CapabilityManifestRecord,
  required: readonly (keyof Pick<
    ProtocolAdapterCapabilities,
    | "identity"
    | "poolState"
    | "entryQuote"
    | "entryCalldata"
    | "sellQuote"
    | "sellCalldata"
    | "finalizeDetection"
    | "liveReceiptEvidence"
  >)[],
): void {
  const missing = required.filter((capability) => manifest[capability] !== "VERIFIED_CURRENT");
  if (missing.length > 0) {
    throw new Error(
      `adapter ${manifest.adapterId} is not HOT_ARMED; missing verified_current: ${missing.join(",")}`,
    );
  }
}
