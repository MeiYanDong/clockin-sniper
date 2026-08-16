import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "../clockin-sniper");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const capabilityBody = await readFile(resolve(packageRoot, "capability-manifest.json"), "utf8");
const capability = JSON.parse(capabilityBody);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: resolve(packageRoot, ".."),
  encoding: "utf8",
}).trim();
const metadata = {
  schemaVersion: 1,
  sourceCommit,
  nodeVersion: process.version,
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  capabilityManifestRevision: capability.manifest_revision,
  capabilityManifestSha256: createHash("sha256").update(capabilityBody).digest("hex"),
  generatedAt: new Date().toISOString(),
};
await writeFile(
  resolve(packageRoot, "BUILD-METADATA.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
  { mode: 0o600 },
);
process.stdout.write(`${JSON.stringify(metadata)}\n`);
