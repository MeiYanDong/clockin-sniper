import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, lstat, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "../clockin-sniper");
const workspaceRoot = resolve(packageRoot, "..");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const capabilityBody = await readFile(resolve(packageRoot, "capability-manifest.json"), "utf8");
const capability = JSON.parse(capabilityBody);
if (!Number.isSafeInteger(capability.manifest_revision) || capability.manifest_revision <= 0) {
  throw new Error("capability manifest revision must be a positive safe integer");
}

const generatedMetadataPath = "clockin-sniper/BUILD-METADATA.json";
const dirtySource = execFileSync(
  "git",
  [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ".",
    `:(exclude)${generatedMetadataPath}`,
  ],
  { cwd: workspaceRoot },
);
if (dirtySource.length > 0) {
  throw new Error("refusing release metadata for a dirty source tree");
}
const sourceCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
  cwd: workspaceRoot,
  encoding: "utf8",
}).trim();
if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
  throw new Error("release source commit is not a full SHA-1 commit id");
}
const metadata = {
  schemaVersion: 2,
  sourceCommit,
  sourceTreeState: "CLEAN_EXCEPT_GENERATED_BUILD_METADATA",
  nodeVersion: process.version,
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  capabilityManifestRevision: capability.manifest_revision,
  capabilityManifestSha256: createHash("sha256").update(capabilityBody).digest("hex"),
  generatedAt: new Date().toISOString(),
};
const metadataPath = resolve(packageRoot, "BUILD-METADATA.json");
try {
  if ((await lstat(metadataPath)).isSymbolicLink()) {
    throw new Error("refusing to replace a symlinked BUILD-METADATA.json");
  }
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
}
const temporaryPath = `${metadataPath}.${process.pid}.tmp`;
await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, {
  mode: 0o600,
  flag: "wx",
});
await rename(temporaryPath, metadataPath);
await chmod(metadataPath, 0o600);
process.stdout.write(`${JSON.stringify(metadata)}\n`);
