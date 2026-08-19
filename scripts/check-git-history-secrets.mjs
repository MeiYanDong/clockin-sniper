import { execFileSync } from "node:child_process";
import { basename, extname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const findings = new Map();
const EVM_PRIVATE_KEY = "0x[0-9a-fA-F]{64}";
const rules = [
  [
    "EVM private key assignment",
    new RegExp(
      `(?:PRIVATE[_-]?KEY|privateKey|walletKey|secretKey)\\s*[:=]\\s*["']?${EVM_PRIVATE_KEY}(?:["']|\\s|,|;|$)`,
      "iu",
    ),
  ],
  [
    "credentialized Chainstack endpoint",
    /(?:https|wss):\/\/[^\s"']*\.chainstack\.com\/[A-Za-z0-9_-]{16,}/u,
  ],
  [
    "seed phrase assignment",
    /(?:MNEMONIC|SEED_PHRASE)\s*[:=]\s*["'][a-z]+(?:\s+[a-z]+){11,23}["']/iu,
  ],
  ["standalone EVM private key", new RegExp(`^\\s*${EVM_PRIVATE_KEY}\\s*$`, "imu")],
  [
    "delimited EVM private key list",
    new RegExp(`${EVM_PRIVATE_KEY}\\s*[,;]\\s*["']?\\s*${EVM_PRIVATE_KEY}`, "u"),
  ],
  [
    "EVM private key array",
    new RegExp(`\\[\\s*["']${EVM_PRIVATE_KEY}["'](?:\\s*[,;]|\\s*\\])`, "u"),
  ],
  ["raw signed transaction assignment", /rawTransaction\s*[:=]\s*["']0x[0-9a-fA-F]{100,}/u],
];

function addFinding(path, rule) {
  findings.set(`${path}\0${rule}`, { path, rule });
}

function scanText(path, contents, metadata = false) {
  for (const [rule, expression] of rules) {
    if (expression.test(contents)) addFinding(path, rule);
  }
  const extension = extname(path).toLowerCase();
  if (metadata || extension === ".json" || extension === ".jsonl") {
    if (new RegExp(`["']${EVM_PRIVATE_KEY}["']`, "u").test(contents)) {
      addFinding(
        path,
        metadata
          ? "quoted EVM private key candidate in Git metadata"
          : "quoted EVM private key candidate in JSON",
      );
    }
  }
  if (extension === ".csv") {
    const csvCell = new RegExp(
      `(?:^|[,;\\r\\n])\\s*["']?${EVM_PRIVATE_KEY}["']?\\s*(?=$|[,;\\r\\n])`,
      "mu",
    );
    if (csvCell.test(contents)) addFinding(path, "EVM private key candidate in CSV");
  }
}

function riskyFileName(path) {
  const name = basename(path);
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) {
    return "environment file committed in history";
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
  if (fileFinding !== null) addFinding(path, fileFinding);
  const paths = blobs.get(objectId) ?? new Set();
  paths.add(path);
  blobs.set(objectId, paths);
}

let scanned = 0;
for (const [objectId, paths] of blobs) {
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
  for (const path of paths) scanText(path, contents);
}

const commitMessages = execFileSync("git", ["log", "--all", "--format=%B"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
});
scanText("Git commit messages", commitMessages, true);
const tagMessages = execFileSync("git", ["for-each-ref", "--format=%(contents)", "refs/tags"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
});
scanText("Git tag messages", tagMessages, true);

if (findings.size > 0) {
  for (const finding of findings.values()) {
    process.stderr.write(`${finding.path}: ${finding.rule}\n`);
  }
  throw new Error(`Git history secret scan found ${findings.size} blocking item(s)`);
}

process.stdout.write(`Git history secret scan passed for ${scanned} unique text blobs\n`);
