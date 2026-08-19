import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const productionEntrypoints = Object.freeze([
  "control-service.ts",
  "stonk-safe-launch-executor-service.ts",
  "prepare-stonk-safe-launch-wallets.ts",
  "reconciler-service.ts",
  "exit-service.ts",
]);

describe("production entrypoint coverage boundary", () => {
  it("imports every shipped process entrypoint without starting network or signer work", async () => {
    const previousExitCode = process.exitCode;
    const stderrWrite = process.stderr.write;
    const stdoutWrite = process.stdout.write;
    try {
      process.stderr.write = (() => {
        throw new Error("an imported production entrypoint wrote to stderr");
      }) as typeof process.stderr.write;
      process.stdout.write = (() => {
        throw new Error("an imported production entrypoint wrote to stdout");
      }) as typeof process.stdout.write;
      for (const entrypoint of productionEntrypoints) {
        const module = await import(new URL(`../src/${entrypoint}`, import.meta.url).href);
        assert.equal(typeof module, "object", entrypoint);
      }
      assert.equal(process.exitCode, previousExitCode);
    } finally {
      process.stderr.write = stderrWrite;
      process.stdout.write = stdoutWrite;
      process.exitCode = previousExitCode;
    }
  });

  it("keeps an explicit direct-execution guard on all long-running entrypoints", async () => {
    for (const entrypoint of productionEntrypoints) {
      const source = await readFile(new URL(`../src/${entrypoint}`, import.meta.url), "utf8");
      assert.match(source, /fileURLToPath\(import\.meta\.url\)/u, entrypoint);
      assert.match(source, /process\.argv\[1\]/u, entrypoint);
    }
  });
});
