import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertAdapterHotArmable,
  createCapabilityManifest,
  type ProtocolAdapterCapabilities,
} from "../src/adapters/capability-manifest.js";

function capabilities(
  overrides: Partial<ProtocolAdapterCapabilities> = {},
): ProtocolAdapterCapabilities {
  return {
    adapterId: "clockin-fixture-v1",
    revision: 1,
    identity: "TESTED",
    poolState: "TESTED",
    entryQuote: "TESTED",
    entryCalldata: "TESTED",
    sellQuote: "SUPPORTED",
    sellCalldata: "SUPPORTED",
    finalizeDetection: "SUPPORTED",
    liveReceiptEvidence: "UNSUPPORTED",
    evidenceIds: ["unit-tests"],
    ...overrides,
  };
}

describe("adapter capability evidence boundary", () => {
  it("records immutable evidence levels and fails HOT_ARMED when tested is not verified-current", () => {
    const manifest = createCapabilityManifest(capabilities(), "2026-08-16T00:00:00Z");
    assert.match(manifest.manifestHash, /^sha256:/);
    assert.throws(
      () => assertAdapterHotArmable(manifest, ["identity", "poolState", "entryCalldata"]),
      /missing verified_current/,
    );
  });

  it("allows only explicitly required capabilities that each have current evidence", () => {
    const manifest = createCapabilityManifest(
      capabilities({
        identity: "VERIFIED_CURRENT",
        poolState: "VERIFIED_CURRENT",
        entryQuote: "VERIFIED_CURRENT",
        entryCalldata: "VERIFIED_CURRENT",
      }),
      "2026-08-16T00:00:00Z",
    );
    assert.doesNotThrow(() =>
      assertAdapterHotArmable(manifest, ["identity", "poolState", "entryQuote", "entryCalldata"]),
    );
    assert.throws(() => assertAdapterHotArmable(manifest, ["sellCalldata"]), /sellCalldata/);
  });
});
