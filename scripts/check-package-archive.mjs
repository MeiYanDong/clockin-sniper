import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

const archive = process.argv[2];
if (archive === undefined) throw new Error("usage: check-package-archive.mjs <package.tgz>");
const temporary = await mkdtemp(join(tmpdir(), "clockin-package-audit-"));
const findings = [];
const archivedFiles = new Set();
const requiredFiles = [
  "package/BUILD-METADATA.json",
  "package/capability-manifest.json",
  "package/dist/live-v2.js",
  "package/dist/v2-index.js",
  "package/package.json",
];
const forbiddenReleasePaths = [
  /^package\/src\//u,
  /^package\/test\//u,
  /^package\/dist\/live\.js$/u,
  /^package\/dist\/live-factory(?:\.|-)/u,
  /^package\/dist\/factory-live(?:\.|-)/u,
  /^package\/dist\/load-secrets(?:\.|-)/u,
];
const contentRules = [
  ["EVM private key", /(?:PRIVATE_KEY|privateKey)\s*[:=]\s*["']?0x[0-9a-fA-F]{64}/u],
  ["credentialized RPC", /(?:https|wss):\/\/[^\s"']*\.chainstack\.com\/[A-Za-z0-9_-]{16,}/u],
  ["seed phrase", /(?:MNEMONIC|SEED_PHRASE)\s*[:=]\s*["'][a-z]+(?:\s+[a-z]+){11,23}["']/iu],
  ["raw signed transaction assignment", /rawTransaction\s*[:=]\s*["']0x[0-9a-fA-F]{100,}/u],
];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) {
      const archivedPath = relative(temporary, path);
      archivedFiles.add(archivedPath);
      if (forbiddenReleasePaths.some((expression) => expression.test(archivedPath))) {
        findings.push(`${archivedPath}: forbidden legacy or source path`);
      }
      if (/\.env(?:\.|$)|wallet-backup|private-key|keystore|\.pem$/iu.test(basename(path))) {
        findings.push(`${archivedPath}: secret-shaped filename`);
      }
      const metadata = await stat(path);
      if (metadata.size > 1_000_000) continue;
      const body = await readFile(path);
      if (body.includes(0)) continue;
      const contents = body.toString("utf8");
      for (const [name, expression] of contentRules) {
        if (expression.test(contents)) findings.push(`${archivedPath}: ${name}`);
      }
    }
  }
}

try {
  execFileSync("tar", ["-xzf", resolve(archive), "-C", temporary], { stdio: "pipe" });
  await walk(temporary);
  for (const requiredFile of requiredFiles) {
    if (!archivedFiles.has(requiredFile)) findings.push(`${requiredFile}: required release file missing`);
  }
  if (findings.length > 0) throw new Error(`package audit failed:\n${findings.join("\n")}`);
  process.stdout.write(
    `package archive boundary and secret scan passed (${archivedFiles.size} files): ${resolve(archive)}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
