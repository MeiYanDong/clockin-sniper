import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const trackedOutput = execFileSync("git", ["ls-files", "-z"], {
  cwd: repositoryRoot,
  encoding: "buffer",
});
const trackedFiles = trackedOutput
  .toString("utf8")
  .split("\0")
  .filter((value) => value.length > 0);

const findings = new Map();
const EVM_PRIVATE_KEY = "0x[0-9a-fA-F]{64}";
const contentRules = [
  {
    name: "EVM private key assignment",
    expression: new RegExp(
      `(?:PRIVATE[_-]?KEY|privateKey|walletKey|secretKey)\\s*[:=]\\s*["']?${EVM_PRIVATE_KEY}(?:["']|\\s|,|;|$)`,
      "iu",
    ),
  },
  {
    name: "wallet private key backup",
    expression: new RegExp(`Private key:\\s*${EVM_PRIVATE_KEY}(?:\\s|$)`, "iu"),
  },
  {
    name: "credentialized Chainstack endpoint",
    expression: /(?:https|wss):\/\/[^\s"']*\.chainstack\.com\/[A-Za-z0-9_-]{16,}/u,
  },
  {
    name: "seed phrase assignment",
    expression: /(?:MNEMONIC|SEED_PHRASE)\s*[:=]\s*["'][a-z]+(?:\s+[a-z]+){11,23}["']/iu,
  },
  {
    name: "standalone EVM private key",
    expression: new RegExp(`^\\s*${EVM_PRIVATE_KEY}\\s*$`, "imu"),
  },
  {
    name: "delimited EVM private key list",
    expression: new RegExp(`${EVM_PRIVATE_KEY}\\s*[,;]\\s*["']?\\s*${EVM_PRIVATE_KEY}`, "u"),
  },
  {
    name: "EVM private key array",
    expression: new RegExp(`\\[\\s*["']${EVM_PRIVATE_KEY}["'](?:\\s*[,;]|\\s*\\])`, "u"),
  },
];

function addFinding(path, rule) {
  findings.set(`${path}\0${rule}`, { path, rule });
}

function structuredSecretRule(path, text) {
  const extension = extname(path).toLowerCase();
  if (extension === ".json" || extension === ".jsonl") {
    if (new RegExp(`["']${EVM_PRIVATE_KEY}["']`, "u").test(text)) {
      return "quoted EVM private key candidate in JSON";
    }
  }
  if (extension === ".csv") {
    const csvCell = new RegExp(
      `(?:^|[,;\\r\\n])\\s*["']?${EVM_PRIVATE_KEY}["']?\\s*(?=$|[,;\\r\\n])`,
      "mu",
    );
    if (csvCell.test(text)) return "EVM private key candidate in CSV";
  }
  return null;
}

function riskyFileName(path) {
  const name = basename(path);
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) {
    return "environment file tracked by Git";
  }
  if (/wallet-backup|private-key|keystore/iu.test(name)) return "secret-shaped filename";
  if (/\.key$/iu.test(name)) return "private key file extension";
  if (/\.(?:pem|p12|pfx)$/iu.test(name)) return "private credential extension";
  if (/^id_(?:rsa|ed25519)$/u.test(name)) return "SSH private-key filename";
  if (
    /\.(?:jsonl?|csv)$/iu.test(name) &&
    /(?:^|[-_.])(?:keys?|wallets?|secrets?|credentials?|mnemonic|seed[-_.]?phrase|entry[-_.]?\d+)(?:[-_.]|$)/iu.test(
      name,
    )
  ) {
    return "key-shaped structured-data filename";
  }
  return null;
}

const allowedRootFiles = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".nvmrc",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
]);
const allowedPrefixes = [".github/", "clockin-sniper/", "docs/", "scripts/"];

for (const path of trackedFiles) {
  if (!allowedRootFiles.has(path) && !allowedPrefixes.some((prefix) => path.startsWith(prefix))) {
    addFinding(path, "outside the exact public repository allowlist");
  }
}

for (const path of trackedFiles) {
  const fileNameFinding = riskyFileName(path);
  if (fileNameFinding !== null) addFinding(path, fileNameFinding);

  const absolute = resolve(repositoryRoot, path);
  const metadata = lstatSync(absolute);
  if (!metadata.isFile() || metadata.size > 1_000_000) continue;
  const body = readFileSync(absolute);
  if (body.includes(0)) continue;
  const text = body.toString("utf8");
  for (const rule of contentRules) {
    if (rule.expression.test(text)) addFinding(path, rule.name);
  }
  const structuredRule = structuredSecretRule(path, text);
  if (structuredRule !== null) addFinding(path, structuredRule);
}

if (findings.size > 0) {
  for (const finding of findings.values()) {
    process.stderr.write(`${finding.path}: ${finding.rule}\n`);
  }
  throw new Error(`public-scope check found ${findings.size} blocking item(s)`);
}

process.stdout.write(`public-scope check passed for ${trackedFiles.length} tracked files\n`);
