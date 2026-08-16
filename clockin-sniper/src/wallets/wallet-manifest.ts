import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Wallet, getAddress } from "ethers";

export interface WalletManifestEntry {
  readonly walletId: string;
  readonly address: `0x${string}`;
  readonly role: "CLOCKIN_ENTRY" | "FIRST_LAUNCH_CANARY" | "MICRO_PROBE";
  readonly expectedChainId: 4663;
}

export interface WalletManifest {
  readonly revision: number;
  readonly generatedAt: string;
  readonly entries: readonly WalletManifestEntry[];
}

export interface GenerateWalletsOptions {
  readonly secretDirectory: string;
  readonly count?: number;
  readonly namespace?: string;
  readonly role?: WalletManifestEntry["role"];
  readonly now?: () => string;
  readonly walletFactory?: () => Readonly<{ privateKey: string; address: string }>;
}

export async function generateWalletManifest(
  options: GenerateWalletsOptions,
): Promise<WalletManifest> {
  const count = options.count ?? 10;
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw new RangeError("wallet count must be between 1 and 100");
  }
  const namespace = options.namespace ?? "entry";
  if (!/^[a-z0-9-]+$/.test(namespace)) throw new RangeError("invalid wallet namespace");
  const directory = resolve(options.secretDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const entries: WalletManifestEntry[] = [];

  for (let index = 1; index <= count; index += 1) {
    const wallet = (options.walletFactory ?? (() => Wallet.createRandom()))();
    const walletId = `${namespace}-${String(index).padStart(2, "0")}`;
    const keyFile = join(directory, `${walletId}.key`);
    await writeFile(keyFile, `${wallet.privateKey}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(keyFile, 0o600);
    entries.push(
      Object.freeze({
        walletId,
        address: getAddress(wallet.address) as `0x${string}`,
        role: options.role ?? "CLOCKIN_ENTRY",
        expectedChainId: 4663,
      }),
    );
  }

  const manifest: WalletManifest = Object.freeze({
    revision: 1,
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    entries: Object.freeze(entries),
  });
  const manifestPath = join(directory, `${namespace}-manifest.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(manifestPath, 0o600);
  return manifest;
}

export async function verifyManifestKeyCorrespondence(
  manifest: WalletManifest,
  secretDirectory: string,
): Promise<readonly { walletId: string; address: `0x${string}`; valid: boolean }[]> {
  const directory = resolve(secretDirectory);
  return Object.freeze(
    await Promise.all(
      manifest.entries.map(async (entry) => {
        const privateKey = (
          await readFile(join(directory, `${entry.walletId}.key`), "utf8")
        ).trim();
        const wallet = new Wallet(privateKey);
        return Object.freeze({
          walletId: entry.walletId,
          address: entry.address,
          valid: wallet.address.toLowerCase() === entry.address.toLowerCase(),
        });
      }),
    ),
  );
}
