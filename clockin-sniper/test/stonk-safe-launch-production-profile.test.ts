import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertLaunchWithinProductionBounds,
  CLOCKIN_APPROVED_LAUNCH_CREATOR,
  CLOCKIN_MINIMUM_DISTINCT_EXECUTABLE_TAX_STATES,
  freezeStonkSafeLaunchProductionProfile,
  parseStonkSafeLaunchProductionProfile,
  ROBINHOOD_WETH_ADDRESS,
  ROBINHOOD_WETH_RUNTIME_CODE_HASH,
  SAFE_LAUNCH_BUFFER_TAX_BPS,
  STONK_SAFE_LAUNCH_QUOTED_ADAPTER_ID,
  STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
  STONK_SAFE_LAUNCH_QUOTED_BUY_LIMIT_POLICY,
  STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
  STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
  STONK_SAFE_LAUNCH_WETH_FACTORY_RUNTIME_CODE_HASH,
  type StonkSafeLaunchProductionProfileDraft,
} from "../src/v2-index.js";

function draft(): StonkSafeLaunchProductionProfileDraft {
  return Object.freeze({
    formatVersion: 2,
    profileId: "clockin-safe-launch-weth-mainnet-v1",
    revision: 1,
    chainId: 4_663,
    adapterId: STONK_SAFE_LAUNCH_QUOTED_ADAPTER_ID,
    factory: Object.freeze({
      address: STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
      runtimeCodeHash: STONK_SAFE_LAUNCH_WETH_FACTORY_RUNTIME_CODE_HASH,
      startBlock: "40100279",
      launchCreatedTopic: STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
      launchArmedTopic: STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
    }),
    quote: Object.freeze({
      asset: ROBINHOOD_WETH_ADDRESS,
      runtimeCodeHash: ROBINHOOD_WETH_RUNTIME_CODE_HASH,
      fundingMode: "PREWRAPPED_WETH",
      allowanceMode: "PREAPPROVED_EXACT_PAD",
    }),
    identity: Object.freeze({
      expectedCreator: CLOCKIN_APPROVED_LAUNCH_CREATOR,
      identityAnchor: "EXACT_FACTORY_APPROVED_CREATOR_FIRST_PRIMARY_EVENT",
      displayNameHint: "CLOCK IN",
      symbolHint: "CLOCKIN",
      metadataAuthority: "AUDIT_ONLY",
      requirePrimaryExternalToken: false,
      officialCa: Object.freeze({
        authority: "AUDIT_ONLY",
        url: "https://clockin.win/",
        jsonKey: "contractAddress",
        pollMs: 500,
      }),
    }),
    mechanismBounds: Object.freeze({
      bufferTaxBps: SAFE_LAUNCH_BUFFER_TAX_BPS,
      maximumBufferSeconds: 3_600,
      maximumStartTaxBps: 10_000,
      maximumEntryTaxBps: 5_000,
      minimumDecayPerMinuteBps: 1,
      minimumWindowSeconds: 60,
      maximumWindowSeconds: 5_940,
      minimumDistinctExecutableTaxStates: CLOCKIN_MINIMUM_DISTINCT_EXECUTABLE_TAX_STATES,
      capMode: STONK_SAFE_LAUNCH_QUOTED_BUY_LIMIT_POLICY.capScope,
      cooldownMode: STONK_SAFE_LAUNCH_QUOTED_BUY_LIMIT_POLICY.cooldownScope,
      floorTaxBps: 0,
      eoaOnly: true,
    }),
    entry: Object.freeze({
      refCode: `0x${"00".repeat(32)}`,
      gasLimit: "500000",
      maximumFeePerGasWei: "2000000000",
      maximumPriorityFeePerGasWei: "1000000000",
      quoteMaximumAgeMs: 15_000,
      maximumEntrySlippageBps: 300,
      maximumExecutionDriftBps: 500,
    }),
    expansion: Object.freeze({
      executionMode: "FIRST_BUYABLE_ALL_TEN",
      requireCanonicalCanaryEffect: false,
      requireStrongOnchainBinding: true,
      requireExecutableExitBeforeLanes2To10: false,
    }),
    evidenceIds: Object.freeze([
      "official-safe-launch-bundle-4696",
      "blockscout-weth-pad-verified-source",
    ]),
    createdAt: "2026-08-20T00:00:00.000Z",
  });
}

describe("quoted Safe Launch production profile", () => {
  it("round-trips the exact pad, WETH, creator, event, and no-exit expansion policy", () => {
    const profile = freezeStonkSafeLaunchProductionProfile(draft());
    assert.deepEqual(
      parseStonkSafeLaunchProductionProfile(JSON.parse(JSON.stringify(profile))),
      profile,
    );
    assert.equal(profile.expansion.requireExecutableExitBeforeLanes2To10, false);
    assert.equal(profile.mechanismBounds.capMode, "NO_CAP");
    assert.equal(profile.mechanismBounds.cooldownMode, "NONE");
    assert.equal(profile.mechanismBounds.minimumDistinctExecutableTaxStates, 1);
  });

  it("rejects any pad, creator, funding mode, hash, or expansion drift", () => {
    const profile = freezeStonkSafeLaunchProductionProfile(draft());
    for (const changed of [
      { ...profile, factory: { ...profile.factory, address: ROBINHOOD_WETH_ADDRESS } },
      { ...profile, identity: { ...profile.identity, expectedCreator: ROBINHOOD_WETH_ADDRESS } },
      { ...profile, quote: { ...profile.quote, fundingMode: "WRAP_AT_LAUNCH" } },
      {
        ...profile,
        expansion: { ...profile.expansion, requireExecutableExitBeforeLanes2To10: true },
      },
      { ...profile, mechanismBounds: { ...profile.mechanismBounds, capMode: "UNKNOWN" } },
      { ...profile, mechanismBounds: { ...profile.mechanismBounds, cooldownMode: "UNKNOWN" } },
      {
        ...profile,
        mechanismBounds: {
          ...profile.mechanismBounds,
          minimumDistinctExecutableTaxStates: 2,
        },
      },
    ]) {
      assert.throws(() => parseStonkSafeLaunchProductionProfile(changed));
    }
    assert.throws(
      () => parseStonkSafeLaunchProductionProfile({ ...profile, profileHash: "tampered" }),
      /hash mismatch/,
    );
  });

  it("authorizes the observed signing tax, not only the launch start tax", () => {
    const profile = freezeStonkSafeLaunchProductionProfile(draft());
    assert.doesNotThrow(() =>
      assertLaunchWithinProductionBounds(profile, {
        startTaxBps: 8_000,
        decayPerMinuteBps: 100,
        windowSeconds: 1_980,
        bufferSeconds: 300,
        externalToken: false,
      }),
    );
    assert.doesNotThrow(() =>
      assertLaunchWithinProductionBounds(profile, {
        startTaxBps: 3_900,
        decayPerMinuteBps: 400,
        windowSeconds: 600,
        bufferSeconds: 300,
        externalToken: false,
      }),
    );
    assert.doesNotThrow(() =>
      assertLaunchWithinProductionBounds(profile, {
        startTaxBps: 3_300,
        decayPerMinuteBps: 128,
        windowSeconds: 1_560,
        bufferSeconds: 300,
        externalToken: false,
      }),
    );
    assert.throws(
      () =>
        assertLaunchWithinProductionBounds(profile, {
          startTaxBps: 10_000,
          decayPerMinuteBps: 100,
          windowSeconds: 1_980,
          bufferSeconds: 300,
          externalToken: false,
        }),
      /never reach/,
    );
    assert.throws(
      () =>
        assertLaunchWithinProductionBounds(profile, {
          startTaxBps: 3_300,
          decayPerMinuteBps: 100,
          windowSeconds: 1_980,
          bufferSeconds: 300,
          externalToken: true,
        }),
      /external-token/,
    );
    assert.doesNotThrow(() =>
      assertLaunchWithinProductionBounds(profile, {
        startTaxBps: 5_000,
        decayPerMinuteBps: 5_000,
        windowSeconds: 60,
        bufferSeconds: 300,
        externalToken: false,
      }),
    );
    assert.throws(
      () =>
        assertLaunchWithinProductionBounds(profile, {
          startTaxBps: 5_001,
          decayPerMinuteBps: 100,
          windowSeconds: 60,
          bufferSeconds: 300,
          externalToken: false,
        }),
      /never reach/,
    );
    const overbroad = freezeStonkSafeLaunchProductionProfile({
      ...draft(),
      mechanismBounds: { ...draft().mechanismBounds, maximumStartTaxBps: 10_001 },
    });
    assert.throws(() => parseStonkSafeLaunchProductionProfile(overbroad), /protocol field bound/);
    assert.throws(
      () =>
        parseStonkSafeLaunchProductionProfile({
          ...profile,
          mechanismBounds: { ...profile.mechanismBounds, maximumEntryTaxBps: 5_001 },
        }),
      /owner-approved execution bound/,
    );
  });
});
