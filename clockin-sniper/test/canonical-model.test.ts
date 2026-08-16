import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CanonicalInvariantError,
  assertDecimalString,
  canonicalJson,
  isAuthorizationUsable,
  stableHash,
  type AuthorizationRecord,
  type EntryIntent,
  type ExitIntent,
} from "../src/core/canonical.js";
import {
  assertTransition,
  factoryProfileTransitions,
  walletLaneTransitions,
} from "../src/core/state-machine.js";

describe("canonical model", () => {
  it("hashes canonical objects independently of insertion order", () => {
    assert.equal(canonicalJson({ b: "2", a: "1" }), '{"a":"1","b":"2"}');
    assert.equal(stableHash({ b: "2", a: "1" }), stableHash({ a: "1", b: "2" }));
  });

  it("rejects float, exponent and non-canonical amount strings", () => {
    for (const invalid of ["1.0", "01", "1e6", "+1", "-0", ""] as const) {
      assert.throws(() => assertDecimalString("amount", invalid), /canonical base-10/);
    }
    assert.doesNotThrow(() => assertDecimalString("amount", "5000000"));
  });

  it("requires authorization scope, risk envelope and expiry to match", () => {
    const authorization: AuthorizationRecord = Object.freeze({
      authorizationId: "auth-1",
      strategyId: "clockin-mainnet-v1",
      revision: 1,
      level: "L2",
      mode: "AUTO_POLICY",
      actorRef: "strategy-policy",
      policyId: "hybrid-ca-gate",
      policyVersion: "1",
      scopeHash: "scope:ok",
      riskEnvelopeHash: "risk:ok",
      issuedAt: "2026-08-16T00:00:00.000Z",
      expiresAt: "2026-08-16T00:02:00.000Z",
      evidenceIds: ["ev-1"],
      reason: "factory, creator and metadata bound",
    });

    assert.equal(
      isAuthorizationUsable(authorization, "scope:ok", "risk:ok", "2026-08-16T00:01:00.000Z"),
      true,
    );
    assert.equal(
      isAuthorizationUsable(authorization, "scope:wrong", "risk:ok", "2026-08-16T00:01:00.000Z"),
      false,
    );
    assert.equal(
      isAuthorizationUsable(authorization, "scope:ok", "risk:ok", "2026-08-16T00:03:00.000Z"),
      false,
    );
  });

  it("allows only declared wallet and factory state transitions", () => {
    assert.doesNotThrow(() =>
      assertTransition(walletLaneTransitions, "UNALLOCATED", "CAPITAL_RESERVED"),
    );
    assert.doesNotThrow(() => assertTransition(factoryProfileTransitions, "VERIFIED", "HOT_ARMED"));
    assert.throws(
      () => assertTransition(walletLaneTransitions, "UNALLOCATED", "EFFECT_CONFIRMED"),
      (error: unknown) =>
        error instanceof CanonicalInvariantError && error.reasonCode === "STATE_TRANSITION_INVALID",
    );
  });

  it("keeps entry and exit intents compile-time distinct", () => {
    const entry = {
      side: "ENTRY",
      action: "BUY",
      trancheNumber: 1,
    } as EntryIntent;
    const exit = {
      side: "EXIT",
      action: "SELL",
      positionLotId: "lot-1",
    } as ExitIntent;

    const acceptsEntry = (intent: EntryIntent): string => intent.side;
    assert.equal(acceptsEntry(entry), "ENTRY");
    // @ts-expect-error ExitIntent cannot be consumed by an entry-only call site.
    acceptsEntry(exit);
  });
});
