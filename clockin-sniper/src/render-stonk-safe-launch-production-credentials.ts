import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  CLOCKIN_APPROVED_LAUNCH_CREATOR,
  ROBINHOOD_WETH_ADDRESS,
  ROBINHOOD_WETH_RUNTIME_CODE_HASH,
  SAFE_LAUNCH_BUFFER_TAX_BPS,
  STONK_SAFE_LAUNCH_QUOTED_ADAPTER_ID,
  STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
  STONK_SAFE_LAUNCH_QUOTED_BUY_LIMIT_POLICY,
  STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
  STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
  STONK_SAFE_LAUNCH_WETH_FACTORY_RUNTIME_CODE_HASH,
} from "./adapters/stonk-safe-launch-quoted.js";
import { loadProductionWalletManifest } from "./runtime/credentials.js";
import { createProductionAuthorization } from "./runtime/production-profile.js";
import {
  CLOCKIN_MAXIMUM_AUTHORIZED_START_TAX_BPS,
  CLOCKIN_MINIMUM_DISTINCT_EXECUTABLE_TAX_STATES,
  freezeStonkSafeLaunchProductionProfile,
} from "./runtime/stonk-safe-launch-production-profile.js";

const PROFILE_EVIDENCE = Object.freeze([
  "https://www.stonkbrokers.cash/safe-launch",
  "https://www.stonkbrokers.cash/_next/static/chunks/4696-4bcb870dc3f9423c.js?dpl=dpl_EJLmsPndPs5YjDS38FRKHPJDyQcf",
  "https://robinhoodchain.blockscout.com/address/0xABEa69101B2a19347A34339F24cAD8b9523E9c29?tab=contract",
  "https://robinhoodchain.blockscout.com/tx/0x225d94ff0010fba0c7791b7f14b48da1f824ce4652f87119659f67b2481fee5f",
  "https://robinhoodchain.blockscout.com/address/0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73?tab=contract",
  "robinhood-mainnet:block=40770297:eth_getCode:0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73:keccak256=0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353",
]);

async function main(): Promise<void> {
  const manifestPath = process.argv[2]?.trim();
  const outputPath = process.argv[3]?.trim();
  if (manifestPath === undefined || outputPath === undefined) {
    throw new Error(
      "usage: render-stonk-safe-launch-production-credentials <manifest> <output-dir>",
    );
  }
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 7 * 24 * 60 * 60 * 1_000);
  const credentialDirectory = resolve(outputPath);
  await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  await chmod(credentialDirectory, 0o700);

  const manifestCredentialDirectory = resolve(credentialDirectory, ".manifest-read");
  await mkdir(manifestCredentialDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(manifestCredentialDirectory, "wallet_manifest"),
    await readFile(resolve(manifestPath), "utf8"),
    { mode: 0o600, flag: "wx" },
  );
  const manifest = await loadProductionWalletManifest({
    CREDENTIALS_DIRECTORY: manifestCredentialDirectory,
  });

  const profile = freezeStonkSafeLaunchProductionProfile({
    formatVersion: 1,
    profileId: "clockin-safe-launch-weth-mainnet-v1",
    revision: 3,
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
      expectedName: "Clock In",
      expectedSymbol: "CLOCKIN",
      requirePrimaryExternalToken: false,
      officialCa: Object.freeze({
        url: "https://clockin.win/",
        jsonKey: "contractAddress",
        pollMs: 500,
      }),
    }),
    mechanismBounds: Object.freeze({
      bufferTaxBps: SAFE_LAUNCH_BUFFER_TAX_BPS,
      maximumBufferSeconds: 3_600,
      maximumStartTaxBps: CLOCKIN_MAXIMUM_AUTHORIZED_START_TAX_BPS,
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
      maximumFeePerGasWei: "200000000",
      maximumPriorityFeePerGasWei: "0",
      quoteMaximumAgeMs: 15_000,
      laterLaneMaximumDriftBps: 300,
      canaryMinimumOutputRaw: "1",
      maximumExecutionDriftBps: 500,
    }),
    expansion: Object.freeze({
      requireCanonicalCanaryEffect: true,
      requireStrongOnchainBinding: true,
      requireExecutableExitBeforeLanes2To10: false,
    }),
    evidenceIds: PROFILE_EVIDENCE,
    createdAt: issuedAt.toISOString(),
  });
  const authorization = createProductionAuthorization({
    authorizationId: `clockin-safe-launch-${issuedAt.toISOString()}`,
    actorRef: "project-owner",
    profile,
    manifest,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    evidenceIds: Object.freeze(["owner-approved-real-snipe", ...PROFILE_EVIDENCE]),
    reason:
      "Seven-day exact WETH Safe Launch pad and approved creator authorization for ten one-shot 5U lanes",
  });
  const outputs = [
    ["factory-profile.json", profile],
    ["production-authorization.json", authorization],
  ] as const;
  for (const [filename, value] of outputs) {
    await writeFile(resolve(credentialDirectory, filename), `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  }
  process.stdout.write(
    `${JSON.stringify({
      state: "CREATED",
      profileId: profile.profileId,
      profileHash: profile.profileHash,
      authorizationId: authorization.authorizationId,
      expiresAt: authorization.expiresAt,
      outputDirectory: credentialDirectory,
      privateKeysRead: false,
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      state: "FAILED",
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
