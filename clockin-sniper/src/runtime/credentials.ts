import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAddress, getBytes, isHexString, Wallet } from "ethers";

import type { WalletManifest, WalletManifestEntry } from "../wallets/wallet-manifest.js";
import {
  type ProductionAuthorization,
  type ProductionProtocolProfile,
  parseProductionAuthorization,
  parseProductionProfile,
} from "./production-profile.js";
import {
  parseStonkSafeLaunchProductionProfile,
  type StonkSafeLaunchProductionProfile,
} from "./stonk-safe-launch-production-profile.js";

export interface LoadedWalletSigner {
  readonly entry: WalletManifestEntry;
  readonly signer: Wallet;
}

function credentialsDirectory(env: NodeJS.ProcessEnv): string {
  const value = env.CREDENTIALS_DIRECTORY?.trim();
  if (value === undefined || value.length === 0)
    throw new Error("CREDENTIALS_DIRECTORY is required");
  return value;
}

export async function readSystemdCredential(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (!/^[a-z0-9_]+$/u.test(name)) throw new TypeError("credential name is invalid");
  const value = (await readFile(join(credentialsDirectory(env), name), "utf8")).trim();
  if (value.length === 0) throw new Error(`credential ${name} is empty`);
  return value;
}

export async function loadProductionWalletSigners(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Readonly<{ manifest: WalletManifest; signers: readonly LoadedWalletSigner[] }>> {
  const manifest = await loadProductionWalletManifest(env);
  const signers = await Promise.all(
    manifest.entries.map(async (entry, index) => {
      const key = await readSystemdCredential(`entry_${String(index + 1).padStart(2, "0")}`, env);
      const signer = new Wallet(key);
      if (signer.address.toLowerCase() !== entry.address.toLowerCase()) {
        throw new Error(`wallet credential ${entry.walletId} does not match its public manifest`);
      }
      return Object.freeze({ entry, signer });
    }),
  );
  return Object.freeze({ manifest, signers: Object.freeze(signers) });
}

export async function loadProductionWalletManifest(
  env: NodeJS.ProcessEnv = process.env,
): Promise<WalletManifest> {
  const value: unknown = JSON.parse(await readSystemdCredential("wallet_manifest", env));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("wallet manifest must be an object");
  }
  const manifest = value as WalletManifest;
  if (
    !Number.isSafeInteger(manifest.revision) ||
    manifest.revision < 1 ||
    typeof manifest.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.generatedAt)) ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length !== 10 ||
    new Set(manifest.entries.map((entry) => entry.walletId)).size !== 10 ||
    new Set(manifest.entries.map((entry) => entry.address.toLowerCase())).size !== 10
  ) {
    throw new Error("wallet manifest must contain ten unique one-shot entries");
  }
  const entries = manifest.entries.map((entry) => {
    if (entry.role !== "CLOCKIN_ENTRY" || entry.expectedChainId !== 4_663) {
      throw new Error(`wallet ${entry.walletId} has the wrong production role or chain`);
    }
    if (!/^entry-[0-9]{2}$/u.test(entry.walletId)) {
      throw new Error("production wallet IDs must use entry-NN ordering");
    }
    return Object.freeze({ ...entry, address: getAddress(entry.address) as `0x${string}` });
  });
  return Object.freeze({
    revision: manifest.revision,
    generatedAt: new Date(manifest.generatedAt).toISOString(),
    entries: Object.freeze(entries),
  });
}

export async function loadProductionProfileAndAuthorization(
  manifest: WalletManifest,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date().toISOString(),
): Promise<
  Readonly<{ profile: ProductionProtocolProfile; authorization: ProductionAuthorization }>
> {
  const profile = parseProductionProfile(
    JSON.parse(await readSystemdCredential("factory_profile", env)),
  );
  const authorization = parseProductionAuthorization(
    JSON.parse(await readSystemdCredential("authorization", env)),
    profile,
    manifest,
    now,
  );
  return Object.freeze({ profile, authorization });
}

export async function loadStonkSafeLaunchProfileAndAuthorization(
  manifest: WalletManifest,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date().toISOString(),
): Promise<
  Readonly<{
    profile: StonkSafeLaunchProductionProfile;
    authorization: ProductionAuthorization;
  }>
> {
  const profile = parseStonkSafeLaunchProductionProfile(
    JSON.parse(await readSystemdCredential("factory_profile", env)),
  );
  const authorization = parseProductionAuthorization(
    JSON.parse(await readSystemdCredential("authorization", env)),
    profile,
    manifest,
    now,
  );
  return Object.freeze({ profile, authorization });
}

export async function loadVaultKey(env: NodeJS.ProcessEnv = process.env): Promise<Uint8Array> {
  const raw = await readSystemdCredential("vault_key", env);
  if (isHexString(raw, 32)) return getBytes(raw);
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32) throw new RangeError("vault_key must be 32-byte hex or base64");
  return new Uint8Array(decoded);
}
