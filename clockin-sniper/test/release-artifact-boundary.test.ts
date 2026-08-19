import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const metadataScript = join(workspaceRoot, "scripts/build-release-metadata.mjs");
const archiveScript = join(workspaceRoot, "scripts/check-package-archive.mjs");
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

const productionEntrypoints = Object.freeze([
  "control-service",
  "stonk-safe-launch-executor-service",
  "prepare-stonk-safe-launch-wallets",
  "reconciler-service",
  "exit-service",
]);

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function git(root: string, ...arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...arguments_], { cwd: root });
  return result.stdout.trim();
}

async function createMetadataFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clockin-release-metadata-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "clockin-sniper"), { recursive: true });
  await copyFile(metadataScript, join(root, "scripts/build-release-metadata.mjs"));
  await writeJson(join(root, "clockin-sniper/package.json"), {
    name: "@local/clockin-sniper",
    version: "9.8.7",
  });
  await writeJson(join(root, "clockin-sniper/capability-manifest.json"), {
    manifest_revision: 77,
    production_state: "NOT_HOT_ARMED",
  });
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "release-test@example.invalid");
  await git(root, "config", "user.name", "Release Test");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "test: release fixture");
  return root;
}

async function createArchiveFixture(): Promise<{
  readonly root: string;
  readonly packageDirectory: string;
  readonly archive: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "clockin-release-archive-"));
  const packageDirectory = join(root, "package");
  const manifestBody = `${JSON.stringify({ manifest_revision: 77 }, null, 2)}\n`;
  const packageBody = `${JSON.stringify({ name: "@local/clockin-sniper", version: "9.8.7" }, null, 2)}\n`;
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, "capability-manifest.json"), manifestBody, "utf8");
  await writeFile(join(packageDirectory, "package.json"), packageBody, "utf8");
  await writeJson(join(packageDirectory, "npm-shrinkwrap.json"), {
    name: "@local/clockin-sniper",
    version: "9.8.7",
    lockfileVersion: 3,
    packages: {},
  });
  await writeJson(join(packageDirectory, "BUILD-METADATA.json"), {
    schemaVersion: 2,
    sourceCommit: "1".repeat(40),
    sourceTreeState: "CLEAN_EXCEPT_GENERATED_BUILD_METADATA",
    nodeVersion: process.version,
    packageName: "@local/clockin-sniper",
    packageVersion: "9.8.7",
    capabilityManifestRevision: 77,
    capabilityManifestSha256: createHash("sha256").update(manifestBody).digest("hex"),
    generatedAt: "2026-08-20T00:00:00.000Z",
  });
  await mkdir(join(packageDirectory, "dist"), { recursive: true });
  for (const entrypoint of [...productionEntrypoints, "v2-index"]) {
    await writeFile(join(packageDirectory, `dist/${entrypoint}.js`), "export {};\n", "utf8");
  }
  await mkdir(join(packageDirectory, "deploy/systemd"), { recursive: true });
  for (const artifact of [
    "deploy/render-systemd.mjs",
    "deploy/control.env.example",
    "deploy/systemd/clockin-control.service.in",
    "deploy/systemd/clockin-executor.service.in",
    "deploy/systemd/clockin-executor.path.in",
    "deploy/systemd/clockin-wallet-preparer.service.in",
    "deploy/systemd/clockin-reconciler.service.in",
    "deploy/systemd/clockin-exit.service.in",
    "deploy/systemd/clockin-sniper.tmpfiles.conf",
  ]) {
    await writeFile(join(packageDirectory, artifact), "fixture\n", "utf8");
  }
  const archive = join(root, "clockin-sniper.tgz");
  return { root, packageDirectory, archive };
}

async function packFixture(root: string, archive: string): Promise<void> {
  await execFileAsync("tar", ["-czf", archive, "-C", root, "package"]);
}

describe("release source and archive binding", () => {
  it("binds clean committed source and exact capability bytes, but permits metadata regeneration", async () => {
    const root = await createMetadataFixture();
    try {
      const script = join(root, "scripts/build-release-metadata.mjs");
      await execFileAsync(process.execPath, [script], { cwd: join(root, "clockin-sniper") });
      const metadataPath = join(root, "clockin-sniper/BUILD-METADATA.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      const capabilityBody = await readFile(
        join(root, "clockin-sniper/capability-manifest.json"),
        "utf8",
      );
      assert.equal(metadata.sourceCommit, await git(root, "rev-parse", "HEAD"));
      assert.equal(metadata.sourceTreeState, "CLEAN_EXCEPT_GENERATED_BUILD_METADATA");
      assert.equal(metadata.capabilityManifestRevision, 77);
      assert.equal(
        metadata.capabilityManifestSha256,
        createHash("sha256").update(capabilityBody).digest("hex"),
      );
      assert.equal((await stat(metadataPath)).mode & 0o777, 0o600);

      await execFileAsync(process.execPath, [script], { cwd: join(root, "clockin-sniper") });
      await writeFile(join(root, "clockin-sniper/package.json"), "{}\n", "utf8");
      await assert.rejects(
        execFileAsync(process.execPath, [script], { cwd: join(root, "clockin-sniper") }),
        /dirty source tree/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts the complete quoted runtime and rejects metadata drift or legacy live output", async () => {
    const valid = await createArchiveFixture();
    try {
      await packFixture(valid.root, valid.archive);
      await execFileAsync(process.execPath, [archiveScript, valid.archive]);

      for (const requiredDeploymentFile of [
        "deploy/render-systemd.mjs",
        "deploy/control.env.example",
        "npm-shrinkwrap.json",
      ] as const) {
        const requiredPath = join(valid.packageDirectory, requiredDeploymentFile);
        const body = await readFile(requiredPath);
        await rm(requiredPath);
        await packFixture(valid.root, valid.archive);
        await assert.rejects(
          execFileAsync(process.execPath, [archiveScript, valid.archive]),
          (error: unknown) =>
            error instanceof Error &&
            error.message.includes(
              `package/${requiredDeploymentFile}: required release file missing`,
            ),
          requiredDeploymentFile,
        );
        await writeFile(requiredPath, body);
      }

      const fakeRawKey = `0x${"0".repeat(64)}`;
      const secondFakeRawKey = `0x${"1".repeat(64)}`;
      const structuredSecret = join(valid.packageDirectory, "arbitrary.json");
      await writeJson(structuredSecret, { unrelatedField: fakeRawKey });
      await packFixture(valid.root, valid.archive);
      let structuredFailure = "";
      try {
        await execFileAsync(process.execPath, [archiveScript, valid.archive]);
      } catch (error: unknown) {
        const failure = error as Error & { readonly stderr?: string; readonly stdout?: string };
        structuredFailure = `${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
      }
      assert.match(structuredFailure, /quoted EVM private key candidate in JSON/u);
      assert.doesNotMatch(structuredFailure, new RegExp(fakeRawKey, "u"));
      await rm(structuredSecret);

      const listSecret = join(valid.packageDirectory, "list.txt");
      await writeFile(listSecret, `${fakeRawKey};${secondFakeRawKey}\n`, "utf8");
      await packFixture(valid.root, valid.archive);
      let listFailure = "";
      try {
        await execFileAsync(process.execPath, [archiveScript, valid.archive]);
      } catch (error: unknown) {
        const failure = error as Error & { readonly stderr?: string; readonly stdout?: string };
        listFailure = `${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
      }
      assert.match(listFailure, /delimited EVM private key list/u);
      assert.doesNotMatch(listFailure, new RegExp(fakeRawKey, "u"));
      assert.doesNotMatch(listFailure, new RegExp(secondFakeRawKey, "u"));
      await rm(listSecret);

      const arraySecret = join(valid.packageDirectory, "array.txt");
      const csvSecret = join(valid.packageDirectory, "rows.csv");
      await writeFile(arraySecret, `["${fakeRawKey}"]\n`, "utf8");
      await writeFile(csvSecret, `1,"${secondFakeRawKey}"\n`, "utf8");
      await packFixture(valid.root, valid.archive);
      let collectionFailure = "";
      try {
        await execFileAsync(process.execPath, [archiveScript, valid.archive]);
      } catch (error: unknown) {
        const failure = error as Error & { readonly stderr?: string; readonly stdout?: string };
        collectionFailure = `${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
      }
      assert.match(collectionFailure, /EVM private key array/u);
      assert.match(collectionFailure, /EVM private key candidate in CSV/u);
      assert.doesNotMatch(collectionFailure, new RegExp(fakeRawKey, "u"));
      assert.doesNotMatch(collectionFailure, new RegExp(secondFakeRawKey, "u"));
      await rm(arraySecret);
      await rm(csvSecret);

      const keyShapedCsv = join(valid.packageDirectory, "wallets.csv");
      await writeFile(keyShapedCsv, "synthetic,fixture\n", "utf8");
      await packFixture(valid.root, valid.archive);
      await assert.rejects(
        execFileAsync(process.execPath, [archiveScript, valid.archive]),
        /key-shaped structured-data filename/u,
      );
      await rm(keyShapedCsv);

      const manifestPath = join(valid.packageDirectory, "capability-manifest.json");
      await writeJson(manifestPath, { manifest_revision: 78 });
      await packFixture(valid.root, valid.archive);
      await assert.rejects(
        execFileAsync(process.execPath, [archiveScript, valid.archive]),
        /capability manifest (?:revision|digest) mismatch/u,
      );

      await writeJson(manifestPath, { manifest_revision: 77 });
      for (const legacyEntrypoint of [
        "dist/live-v2.js",
        "dist/executor-service.js",
        "dist/create-wallet-batch.js",
      ]) {
        const legacyPath = join(valid.packageDirectory, legacyEntrypoint);
        await writeFile(legacyPath, "export {};\n", "utf8");
        await packFixture(valid.root, valid.archive);
        await assert.rejects(
          execFileAsync(process.execPath, [archiveScript, valid.archive]),
          /forbidden legacy or source path/u,
          legacyEntrypoint,
        );
        await rm(legacyPath);
      }
    } finally {
      await rm(valid.root, { recursive: true, force: true });
    }
  });

  it("builds and audits a real npm archive in an isolated temporary directory", async () => {
    const fixture = await createArchiveFixture();
    try {
      await mkdir(join(fixture.root, "scripts"), { recursive: true });
      await copyFile(archiveScript, join(fixture.root, "scripts/check-package-archive.mjs"));
      await rename(fixture.packageDirectory, join(fixture.root, "clockin-sniper"));
      const result = await execFileAsync(
        process.execPath,
        [join(fixture.root, "scripts/check-package-archive.mjs"), "--pack"],
        { cwd: join(fixture.root, "clockin-sniper") },
      );
      assert.match(result.stdout, /package archive boundary and secret scan passed/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps build roots and coverage gates explicit instead of relying on broad globs", async () => {
    const [buildConfigBody, packageBody] = await Promise.all([
      readFile(join(packageRoot, "tsconfig.build.json"), "utf8"),
      readFile(join(packageRoot, "package.json"), "utf8"),
    ]);
    const buildConfig = JSON.parse(buildConfigBody) as { readonly include: readonly string[] };
    assert.deepEqual(buildConfig.include, [
      "src/v2-index.ts",
      ...productionEntrypoints.map((entrypoint) => `src/${entrypoint}.ts`),
    ]);
    const packageJson = JSON.parse(packageBody) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    assert.match(packageJson.scripts.coverage ?? "", /coverage:production-entrypoints/u);
    const entryCoverage = packageJson.scripts["coverage:production-entrypoints"] ?? "";
    for (const entrypoint of productionEntrypoints) {
      assert.equal(entryCoverage.includes(entrypoint), true, entrypoint);
    }
    assert.match(entryCoverage, /test-coverage-lines=28/u);
    assert.match(entryCoverage, /test-coverage-branches=70/u);
    assert.match(entryCoverage, /test-coverage-functions=60/u);
    assert.match(packageJson.scripts.executor ?? "", /stonk-safe-launch-executor-service\.js/u);
    assert.equal(packageJson.scripts["package:dry-run"], "npm pack --dry-run");
    assert.match(packageJson.scripts["package:audit"] ?? "", /check-package-archive\.mjs --pack/u);
    assert.doesNotMatch(
      JSON.stringify(buildConfig.include),
      /live|"src\/executor-service\.ts"|create-wallet/u,
    );
  });
});
