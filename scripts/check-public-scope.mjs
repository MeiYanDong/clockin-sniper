import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const trackedOutput = execFileSync("git", ["ls-files", "-z"], {
  cwd: repositoryRoot,
  encoding: "buffer",
});
const trackedFiles = trackedOutput
  .toString("utf8")
  .split("\0")
  .filter((value) => value.length > 0);

const findings = [];
const contentRules = [
  {
    name: "EVM private key assignment",
    expression: /(?:PRIVATE_KEY|privateKey)\s*[:=]\s*["']?0x[0-9a-fA-F]{64}(?:["']|\s|$)/u,
  },
  {
    name: "wallet private key backup",
    expression: /Private key:\s*0x[0-9a-fA-F]{64}(?:\s|$)/u,
  },
  {
    name: "credentialized Chainstack endpoint",
    expression: /(?:https|wss):\/\/[^\s"']*\.chainstack\.com\/[A-Za-z0-9_-]{16,}/u,
  },
  {
    name: "seed phrase assignment",
    expression: /(?:MNEMONIC|SEED_PHRASE)\s*[:=]\s*["'][a-z]+(?:\s+[a-z]+){11,23}["']/iu,
  },
];

function riskyFileName(path) {
  const name = basename(path);
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) {
    return "environment file tracked by Git";
  }
  if (/wallet-backup|private-key|keystore/iu.test(name)) return "secret-shaped filename";
  if (/\.(?:pem|p12|pfx)$/iu.test(name)) return "private credential extension";
  if (/^id_(?:rsa|ed25519)$/u.test(name)) return "SSH private-key filename";
  return null;
}

for (const path of trackedFiles) {
  const fileNameFinding = riskyFileName(path);
  if (fileNameFinding !== null) findings.push({ path, rule: fileNameFinding });

  const absolute = resolve(repositoryRoot, path);
  const metadata = lstatSync(absolute);
  if (!metadata.isFile() || metadata.size > 1_000_000) continue;
  const body = readFileSync(absolute);
  if (body.includes(0)) continue;
  const text = body.toString("utf8");
  for (const rule of contentRules) {
    if (rule.expression.test(text)) findings.push({ path, rule: rule.name });
  }
}

if (findings.length > 0) {
  for (const finding of findings) process.stderr.write(`${finding.path}: ${finding.rule}\n`);
  throw new Error(`public-scope check found ${findings.length} blocking item(s)`);
}

const forbiddenPrefixes = ["analysis/", "sniper-engineering/", "sniper-engineering-v1.5/"];
const forbidden = trackedFiles.filter((path) =>
  forbiddenPrefixes.some((prefix) => path.startsWith(prefix)),
);
if (forbidden.length > 0) {
  for (const path of forbidden) process.stderr.write(`${path}: outside public repository scope\n`);
  throw new Error(`public-scope check found ${forbidden.length} out-of-scope tracked file(s)`);
}

process.stdout.write(`public-scope check passed for ${trackedFiles.length} tracked files\n`);
