import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const root = process.cwd();
const excludedDirectories = new Set([".git", "node_modules", "dist", "coverage"]);
const findings = new Map<string, { readonly path: string; readonly rule: string }>();

const EVM_PRIVATE_KEY = "0x[0-9a-fA-F]{64}";

const contentRules: ReadonlyArray<{ readonly name: string; readonly expression: RegExp }> = [
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

function addFinding(path: string, rule: string): void {
  findings.set(`${path}\0${rule}`, { path, rule });
}

function structuredSecretRule(path: string, text: string): string | null {
  const extension = extname(path).toLowerCase();
  if (extension === ".json" || extension === ".jsonl") {
    const quotedKey = new RegExp(`["']${EVM_PRIVATE_KEY}["']`, "u");
    if (quotedKey.test(text)) return "quoted EVM private key candidate in JSON";
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

function riskyFileName(name: string): string | null {
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) {
    return "environment file inside repository";
  }
  if (/wallet-backup|private-key|keystore/iu.test(name)) return "secret-shaped filename";
  if (/\.key$/iu.test(name)) return "private key file extension";
  if (/\.(?:pem|p12|pfx)$/iu.test(name)) return "private credential file extension";
  if (/^id_(?:rsa|ed25519)$/u.test(name)) return "SSH private key filename";
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

async function walk(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolute = resolve(directory, entry.name);
    const displayPath = relative(root, absolute) || ".";
    const fileNameFinding = riskyFileName(entry.name);
    if (fileNameFinding !== null) addFinding(displayPath, fileNameFinding);
    if (entry.isDirectory()) {
      await walk(absolute);
      continue;
    }
    if (!entry.isFile()) continue;
    const metadata = await lstat(absolute);
    if (metadata.size > 1_000_000) continue;
    const body = await readFile(absolute);
    if (body.includes(0)) continue;
    const text = body.toString("utf8");
    for (const rule of contentRules) {
      if (rule.expression.test(text)) addFinding(displayPath, rule.name);
    }
    const structuredRule = structuredSecretRule(displayPath, text);
    if (structuredRule !== null) addFinding(displayPath, structuredRule);
  }
}

await walk(root);
if (findings.size > 0) {
  for (const finding of findings.values()) {
    process.stderr.write(`${finding.path}: ${finding.rule}\n`);
  }
  throw new Error(`repository secret check found ${findings.size} blocking item(s)`);
}
process.stdout.write("repository secret check passed\n");
