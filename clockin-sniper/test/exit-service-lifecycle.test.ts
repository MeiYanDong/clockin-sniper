import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideExitPaidLifecycle } from "../src/exit-service.js";

describe("Exit paid lifecycle", () => {
  it("continues only while the authorization remains valid", () => {
    assert.deepEqual(
      decideExitPaidLifecycle({
        nowMs: 999,
        authorizationExpiresAtMs: 1_000,
        unresolvedAttemptCount: 0,
        openPositionCount: 0,
      }),
      { action: "RUN", details: [] },
    );
  });

  it("exits normally at authorization expiry when there is no recovery or position work", () => {
    assert.deepEqual(
      decideExitPaidLifecycle({
        nowMs: 1_000,
        authorizationExpiresAtMs: 1_000,
        unresolvedAttemptCount: 0,
        openPositionCount: 0,
      }),
      { action: "STOP_IDLE", details: ["AUTHORIZATION_EXPIRED_NO_EXPOSURE"] },
    );
  });

  it("stops degraded instead of empty-polling when expired exposure still needs intervention", () => {
    for (const [unresolvedAttemptCount, openPositionCount] of [
      [1, 0],
      [0, 1],
      [2, 3],
    ] as const) {
      assert.deepEqual(
        decideExitPaidLifecycle({
          nowMs: 1_001,
          authorizationExpiresAtMs: 1_000,
          unresolvedAttemptCount,
          openPositionCount,
        }),
        {
          action: "STOP_DEGRADED",
          details: [
            "AUTHORIZATION_EXPIRED_RECOVERY_OR_POSITION_REMAINS",
            `UNRESOLVED_ATTEMPTS_${unresolvedAttemptCount}`,
            `OPEN_POSITIONS_${openPositionCount}`,
          ],
        },
      );
    }
  });

  it("rejects malformed exposure counts", () => {
    assert.throws(
      () =>
        decideExitPaidLifecycle({
          nowMs: 1_000,
          authorizationExpiresAtMs: 2_000,
          unresolvedAttemptCount: -1,
          openPositionCount: 0,
        }),
      /non-negative safe integer/u,
    );
  });
});
