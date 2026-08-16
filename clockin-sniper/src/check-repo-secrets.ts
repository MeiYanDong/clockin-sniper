import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = process.cwd();
const excludedDirectories = new Set([".git", "node_modules", "dist", "coverage"]);
const findings: Array<{ readonly path: string; readonly rule: string }> = [];

const contentRules: ReadonlyArray<{ readonly name: string; readonly expression: RegExp }> = [
  {
    name: "live CLOCKIN private key assignment",
    expression: /CLOCKIN_PRIVATE_KEY\s*=\s*0x[0-9a-fA-F]{64}(?:\s|$)/u,
  },
  {
    name: "wallet private key backup",
    expression: /Private key:\s*0x[0-9a-fA-F]{64}(?:\s|$)/u,
  },
  {
    name: "credentialized Chainstack endpoint",
    expression: /(?:https|wss):\/\/[^\s"']*\.chainstack\.com\/[A-Za-z0-9_-]{16,}/u,
  },
];

function riskyFileName(name: string): string | null {
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) {
    return "environment file inside repository";
  }
  if (/wallet-backup|private-key|keystore/iu.test(name)) return "secret-shaped filename";
  if (/\.(?:pem|p12|pfx)$/iu.test(name)) return "private credential file extension";
  if (/^id_(?:rsa|ed25519)$/u.test(name)) return "SSH private key filename";
  return null;
}

async function walk(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolute = resolve(directory, entry.name);
    const displayPath = relative(root, absolute) || ".";
    const fileNameFinding = riskyFileName(entry.name);
    if (fileNameFinding !== null) findings.push({ path: displayPath, rule: fileNameFinding });
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
      if (rule.expression.test(text)) findings.push({ path: displayPath, rule: rule.name });
    }
  }
}

await walk(root);
if (findings.length > 0) {
  for (const finding of findings) process.stderr.write(`${finding.path}: ${finding.rule}\n`);
  throw new Error(`repository secret check found ${findings.length} blocking item(s)`);
}
process.stdout.write("repository secret check passed\n");
