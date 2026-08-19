import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const treeScanner = join(packageRoot, "src/check-repo-secrets.ts");
const tsxExecutable = join(packageRoot, "node_modules/.bin/tsx");
const publicScopeScanner = join(workspaceRoot, "scripts/check-public-scope.mjs");
const historyScanner = join(workspaceRoot, "scripts/check-git-history-secrets.mjs");

interface CommandFailure extends Error {
  readonly stdout?: string | Buffer;
  readonly stderr?: string | Buffer;
}

async function runExpectingFailure(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<string> {
  let caught: unknown;
  try {
    await execFileAsync(executable, [...arguments_], { cwd, encoding: "utf8" });
  } catch (error: unknown) {
    caught = error;
  }
  assert.ok(caught instanceof Error, `${executable} unexpectedly accepted a secret fixture`);
  const failure = caught as CommandFailure;
  return `${String(failure.stdout ?? "")}\n${String(failure.stderr ?? "")}`;
}

async function git(root: string, ...arguments_: readonly string[]): Promise<void> {
  await execFileAsync("git", [...arguments_], { cwd: root, encoding: "utf8" });
}

async function createTrackedSecretFixture(): Promise<{
  readonly root: string;
  readonly fakeRawKey: string;
  readonly secondFakeRawKey: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "clockin-secret-boundary-"));
  const fakeRawKey = `0x${"0".repeat(64)}`;
  const secondFakeRawKey = `0x${"1".repeat(64)}`;
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await copyFile(publicScopeScanner, join(root, "scripts/check-public-scope.mjs"));
  await copyFile(historyScanner, join(root, "scripts/check-git-history-secrets.mjs"));
  await writeFile(join(root, "payload.txt"), `${fakeRawKey}\n`, "utf8");
  await writeFile(join(root, "entry-01.key"), "synthetic fixture; no credential\n", "utf8");
  await writeFile(
    join(root, "docs/arbitrary.json"),
    `${JSON.stringify({ transaction: secondFakeRawKey })}\n`,
    "utf8",
  );
  await writeFile(join(root, "docs/list.txt"), `${fakeRawKey}; ${secondFakeRawKey}\n`, "utf8");
  await writeFile(join(root, "docs/array.txt"), `["${fakeRawKey}"]\n`, "utf8");
  await writeFile(join(root, "docs/rows.csv"), `1,"${secondFakeRawKey}"\n`, "utf8");
  await writeFile(join(root, "docs/wallets.csv"), "synthetic,fixture\n", "utf8");
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "secret-boundary@example.invalid");
  await git(root, "config", "user.name", "Secret Boundary Test");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "test: secret boundary fixture");
  return { root, fakeRawKey, secondFakeRawKey };
}

describe("repository secret boundaries", () => {
  it("rejects private-key filenames and standalone raw EVM keys in the working tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "clockin-tree-secret-boundary-"));
    const fakeRawKey = `0x${"0".repeat(64)}`;
    const secondFakeRawKey = `0x${"1".repeat(64)}`;
    try {
      await writeFile(join(root, "payload.txt"), `${fakeRawKey}\n`, "utf8");
      await writeFile(join(root, "entry-01.key"), "synthetic fixture; no credential\n", "utf8");
      await writeFile(
        join(root, "arbitrary.json"),
        `${JSON.stringify({ unrelatedField: fakeRawKey })}\n`,
        "utf8",
      );
      await writeFile(join(root, "keys.txt"), `${fakeRawKey},${secondFakeRawKey}\n`, "utf8");
      await writeFile(join(root, "array.txt"), `["${fakeRawKey}"]\n`, "utf8");
      await writeFile(join(root, "rows.csv"), `1,"${secondFakeRawKey}"\n`, "utf8");
      await writeFile(join(root, "wallets.csv"), "synthetic,fixture\n", "utf8");
      const output = await runExpectingFailure(tsxExecutable, [treeScanner], root);
      assert.match(output, /entry-01\.key: private key file extension/u);
      assert.match(output, /payload\.txt: standalone EVM private key/u);
      assert.match(output, /arbitrary\.json: quoted EVM private key candidate in JSON/u);
      assert.match(output, /keys\.txt: delimited EVM private key list/u);
      assert.match(output, /array\.txt: EVM private key array/u);
      assert.match(output, /rows\.csv: EVM private key candidate in CSV/u);
      assert.match(output, /wallets\.csv: key-shaped structured-data filename/u);
      assert.doesNotMatch(output, new RegExp(fakeRawKey, "u"));
      assert.doesNotMatch(output, new RegExp(secondFakeRawKey, "u"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects private-key filenames and standalone raw EVM keys in public scope and history", async () => {
    const { root, fakeRawKey, secondFakeRawKey } = await createTrackedSecretFixture();
    try {
      for (const script of ["check-public-scope.mjs", "check-git-history-secrets.mjs"] as const) {
        const output = await runExpectingFailure(
          process.execPath,
          [join(root, "scripts", script)],
          root,
        );
        assert.match(output, /entry-01\.key: private key file extension/u, script);
        assert.match(output, /payload\.txt: standalone EVM private key/u, script);
        assert.match(
          output,
          /docs\/arbitrary\.json: quoted EVM private key candidate in JSON/u,
          script,
        );
        assert.match(output, /docs\/list\.txt: delimited EVM private key list/u, script);
        assert.match(output, /docs\/array\.txt: EVM private key array/u, script);
        assert.match(output, /docs\/rows\.csv: EVM private key candidate in CSV/u, script);
        assert.match(output, /docs\/wallets\.csv: key-shaped structured-data filename/u, script);
        assert.doesNotMatch(output, new RegExp(fakeRawKey, "u"), script);
        assert.doesNotMatch(output, new RegExp(secondFakeRawKey, "u"), script);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown top-level public files under an exact allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "clockin-public-allowlist-"));
    try {
      await mkdir(join(root, "scripts"), { recursive: true });
      await copyFile(publicScopeScanner, join(root, "scripts/check-public-scope.mjs"));
      await writeFile(join(root, "README.md"), "fixture\n", "utf8");
      await writeFile(join(root, "NOTES.md"), "fixture\n", "utf8");
      await git(root, "init", "--quiet");
      await git(root, "config", "user.email", "public-allowlist@example.invalid");
      await git(root, "config", "user.name", "Public Allowlist Test");
      await git(root, "add", ".");
      await git(root, "commit", "--quiet", "-m", "test: public allowlist fixture");
      const output = await runExpectingFailure(
        process.execPath,
        [join(root, "scripts/check-public-scope.mjs")],
        root,
      );
      assert.match(output, /NOTES\.md: outside the exact public repository allowlist/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scans both commit and annotated-tag messages without echoing key candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "clockin-git-message-secret-"));
    const commitKey = `0x${"2".repeat(64)}`;
    const tagKey = `0x${"3".repeat(64)}`;
    try {
      await mkdir(join(root, "scripts"), { recursive: true });
      await copyFile(historyScanner, join(root, "scripts/check-git-history-secrets.mjs"));
      await writeFile(join(root, "README.md"), "fixture\n", "utf8");
      await git(root, "init", "--quiet");
      await git(root, "config", "user.email", "git-message@example.invalid");
      await git(root, "config", "user.name", "Git Message Test");
      await git(root, "add", ".");
      await git(root, "commit", "--quiet", "-m", `privateKey=${commitKey}`);
      await git(root, "tag", "--annotate", "fixture-tag", "-m", `["${tagKey}"]`);
      const output = await runExpectingFailure(
        process.execPath,
        [join(root, "scripts/check-git-history-secrets.mjs")],
        root,
      );
      assert.match(output, /Git commit messages: EVM private key assignment/u);
      assert.match(output, /Git tag messages: quoted EVM private key candidate in Git metadata/u);
      assert.doesNotMatch(output, new RegExp(commitKey, "u"));
      assert.doesNotMatch(output, new RegExp(tagKey, "u"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps production wallet-key paths ignored even before a file exists", async () => {
    const result = await execFileAsync(
      "git",
      ["check-ignore", "--no-index", "--verbose", "clockin-sniper/entry-01.key"],
      { cwd: workspaceRoot, encoding: "utf8" },
    );
    assert.match(result.stdout, /\.gitignore:\d+:\*\*\/\*\.key/u);
    assert.match(result.stdout, /clockin-sniper\/entry-01\.key/u);
  });
});
