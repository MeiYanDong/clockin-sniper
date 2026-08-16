import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { WalletManifest } from "./wallets/wallet-manifest.js";

function requiredUrl(name: "ROBINHOOD_RPC_URL" | "ROBINHOOD_WS_RPC_URL"): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  const parsed = new URL(value);
  const allowed =
    name === "ROBINHOOD_RPC_URL"
      ? parsed.protocol === "https:" || parsed.protocol === "http:"
      : parsed.protocol === "wss:" || parsed.protocol === "ws:";
  if (!allowed) throw new Error(`${name} uses an invalid protocol`);
  return value;
}

async function main(): Promise<void> {
  const credentialDirectory = process.argv[2]?.trim();
  const publicDirectory = process.argv[3]?.trim();
  const manifestPath = process.argv[4]?.trim();
  if (
    credentialDirectory === undefined ||
    publicDirectory === undefined ||
    manifestPath === undefined
  ) {
    throw new Error(
      "usage: stage-control-credentials <new-credential-directory> <new-public-directory> <wallet-manifest-path>",
    );
  }
  const credentialTarget = resolve(credentialDirectory);
  const publicTarget = resolve(publicDirectory);
  await mkdir(credentialTarget, { mode: 0o700 });
  await chmod(credentialTarget, 0o700);
  await mkdir(publicTarget, { mode: 0o755 });
  await chmod(publicTarget, 0o755);
  const manifestRaw = await readFile(resolve(manifestPath), "utf8");
  const manifest = JSON.parse(manifestRaw) as WalletManifest;
  if (manifest.entries.length !== 10) throw new Error("wallet manifest must contain 10 entries");
  const credentialFiles = [
    ["rpc_http", requiredUrl("ROBINHOOD_RPC_URL")],
    ["rpc_wss", requiredUrl("ROBINHOOD_WS_RPC_URL")],
  ] as const;
  for (const [name, contents] of credentialFiles) {
    const path = join(credentialTarget, name);
    await writeFile(path, contents.endsWith("\n") ? contents : `${contents}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(path, 0o600);
  }
  const publicManifest = join(publicTarget, "entry-manifest.json");
  await writeFile(publicManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o444,
  });
  await chmod(publicManifest, 0o444);
  process.stdout.write(
    `${JSON.stringify({
      stagedCredentials: credentialFiles.map(([name]) => name),
      stagedPublicFiles: ["entry-manifest.json"],
      target: "[repository-external]",
      privateKeysStaged: false,
      rpcValuesPrinted: false,
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
