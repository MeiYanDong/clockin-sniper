import { readFile } from "node:fs/promises";

interface PublicCapabilityManifest {
  readonly manifest_revision: number;
  readonly production_state: string;
  readonly blockers: readonly string[];
}

async function main(): Promise<void> {
  const path = new URL("../capability-manifest.json", import.meta.url);
  const manifest = JSON.parse(await readFile(path, "utf8")) as PublicCapabilityManifest;
  const result = Object.freeze({
    service: "clockin-v2-live",
    state: manifest.production_state,
    capabilityManifestRevision: manifest.manifest_revision,
    blockers: manifest.blockers,
    signed: false,
    broadcast: false,
    message:
      "v2 refuses to load signer credentials until final mainnet profiles and every readiness gate are VERIFIED_CURRENT",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (manifest.production_state !== "HOT_ARMED") process.exitCode = 2;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      service: "clockin-v2-live",
      state: "NOT_HOT_ARMED",
      signed: false,
      broadcast: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 2;
});
