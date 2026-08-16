import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const findings = [];
const rules = [
  [
    "EVM private key assignment",
    /(?:PRIVATE_KEY|privateKey)\s*[:=]\s*["']?0x[0-9a-fA-F]{64}(?:["']|\s|$)/u,
  ],
  [
    "credentialized Chainstack endpoint",
    /(?:https|wss):\/\/[^\s"']*\.chainstack\.com\/[A-Za-z0-9_-]{16,}/u,
  ],
  [
    "seed phrase assignment",
    /(?:MNEMONIC|SEED_PHRASE)\s*[:=]\s*["'][a-z]+(?:\s+[a-z]+){11,23}["']/iu,
  ],
  ["raw signed transaction assignment", /rawTransaction\s*[:=]\s*["']0x[0-9a-fA-F]{100,}/u],
];

function riskyFileName(path) {
  const name = basename(path);
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) {
    return "environment file committed in history";
  }
  if (/wallet-backup|private-key|keystore/iu.test(name)) return "secret-shaped filename";
  if (/\.(?:pem|p12|pfx)$/iu.test(name)) return "private credential extension";
  if (/^id_(?:rsa|ed25519)$/u.test(name)) return "SSH private-key filename";
  return null;
}

const objectLines = execFileSync("git", ["rev-list", "--objects", "--all"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  maxBuffer: 50 * 1024 * 1024,
})
  .split("\n")
  .filter(Boolean);
const blobs = new Map();

for (const line of objectLines) {
  const separator = line.indexOf(" ");
  if (separator < 0) continue;
  const objectId = line.slice(0, separator);
  const path = line.slice(separator + 1);
  const fileFinding = riskyFileName(path);
  if (fileFinding !== null) findings.push({ path, rule: fileFinding });
  if (!blobs.has(objectId)) blobs.set(objectId, path);
}

let scanned = 0;
for (const [objectId, path] of blobs) {
  const type = execFileSync("git", ["cat-file", "-t", objectId], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  if (type !== "blob") continue;
  const size = Number(
    execFileSync("git", ["cat-file", "-s", objectId], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim(),
  );
  if (!Number.isFinite(size) || size > 1_000_000) continue;
  const body = execFileSync("git", ["cat-file", "blob", objectId], {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 2_000_000,
  });
  if (body.includes(0)) continue;
  scanned += 1;
  const contents = body.toString("utf8");
  for (const [rule, expression] of rules) {
    if (expression.test(contents)) findings.push({ path, rule });
  }
}

if (findings.length > 0) {
  for (const finding of findings) process.stderr.write(`${finding.path}: ${finding.rule}\n`);
  throw new Error(`Git history secret scan found ${findings.length} blocking item(s)`);
}

process.stdout.write(`Git history secret scan passed for ${scanned} unique text blobs\n`);
