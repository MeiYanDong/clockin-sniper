import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";

const requestedArchive = process.argv[2];
if (requestedArchive === undefined) {
  throw new Error("usage: check-package-archive.mjs <package.tgz|--pack>");
}
const packageRoot = resolve(import.meta.dirname, "../clockin-sniper");
let packageTemporary = null;
let archive = requestedArchive;
if (requestedArchive === "--pack") {
  packageTemporary = await mkdtemp(join(tmpdir(), "clockin-package-build-"));
  try {
    const npmCli = process.env.npm_execpath;
    if (npmCli === undefined || npmCli.length === 0) {
      execFileSync("npm", ["pack", "--pack-destination", packageTemporary], {
        cwd: packageRoot,
        stdio: "pipe",
      });
    } else {
      execFileSync(process.execPath, [npmCli, "pack", "--pack-destination", packageTemporary], {
        cwd: packageRoot,
        stdio: "pipe",
      });
    }
    const archives = (await readdir(packageTemporary)).filter((name) => name.endsWith(".tgz"));
    if (archives.length !== 1 || archives[0] === undefined) {
      throw new Error(`npm pack produced ${archives.length} archives instead of exactly one`);
    }
    archive = join(packageTemporary, archives[0]);
  } catch (error) {
    await rm(packageTemporary, { recursive: true, force: true });
    packageTemporary = null;
    throw error;
  }
}
const temporary = await mkdtemp(join(tmpdir(), "clockin-package-audit-"));
const findings = new Map();
const archivedFiles = new Set();
const requiredFiles = [
  "package/BUILD-METADATA.json",
  "package/capability-manifest.json",
  "package/dist/control-service.js",
  "package/dist/stonk-safe-launch-executor-service.js",
  "package/dist/prepare-stonk-safe-launch-wallets.js",
  "package/dist/reconciler-service.js",
  "package/dist/exit-service.js",
  "package/dist/v2-index.js",
  "package/deploy/render-systemd.mjs",
  "package/deploy/control.env.example",
  "package/deploy/systemd/clockin-control.service.in",
  "package/deploy/systemd/clockin-executor.service.in",
  "package/deploy/systemd/clockin-executor.path.in",
  "package/deploy/systemd/clockin-wallet-preparer.service.in",
  "package/deploy/systemd/clockin-reconciler.service.in",
  "package/deploy/systemd/clockin-exit.service.in",
  "package/deploy/systemd/clockin-sniper.tmpfiles.conf",
  "package/package.json",
  "package/npm-shrinkwrap.json",
];
const forbiddenReleasePaths = [
  /^package\/src\//u,
  /^package\/test\//u,
  /^package\/dist\/live(?:\.|-)/u,
  /^package\/dist\/live-v2(?:\.|-)/u,
  /^package\/dist\/live-factory(?:\.|-)/u,
  /^package\/dist\/reconcile-live(?:\.|-)/u,
  /^package\/dist\/executor-service(?:\.|-)/u,
  /^package\/dist\/create-wallet(?:-batch)?(?:\.|-)/u,
  /^package\/dist\/render-stonk-safe-launch-production-credentials(?:\.|-)/u,
  /^package\/dist\/stage-control-credentials(?:\.|-)/u,
  /^package\/dist\/smoke-(?:rpc|sequencer|wss)(?:\.|-)/u,
  /^package\/dist\/factory-live(?:\.|-)/u,
  /^package\/dist\/load-secrets(?:\.|-)/u,
];
const EVM_PRIVATE_KEY = "0x[0-9a-fA-F]{64}";
const contentRules = [
  [
    "EVM private key assignment",
    new RegExp(
      `(?:PRIVATE[_-]?KEY|privateKey|walletKey|secretKey)\\s*[:=]\\s*["']?${EVM_PRIVATE_KEY}(?:["']|\\s|,|;|$)`,
      "iu",
    ),
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
  ["credentialized RPC", /(?:https|wss):\/\/[^\s"']*\.chainstack\.com\/[A-Za-z0-9_-]{16,}/u],
  ["seed phrase", /(?:MNEMONIC|SEED_PHRASE)\s*[:=]\s*["'][a-z]+(?:\s+[a-z]+){11,23}["']/iu],
  ["raw signed transaction assignment", /rawTransaction\s*[:=]\s*["']0x[0-9a-fA-F]{100,}/u],
];

function addFinding(path, rule) {
  findings.set(`${path}\0${rule}`, `${path}: ${rule}`);
}

function riskyStructuredFileName(name) {
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

function scanStructured(path, contents) {
  const extension = extname(path).toLowerCase();
  if (extension === ".json" || extension === ".jsonl") {
    if (new RegExp(`["']${EVM_PRIVATE_KEY}["']`, "u").test(contents)) {
      addFinding(path, "quoted EVM private key candidate in JSON");
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

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) {
      const archivedPath = relative(temporary, path);
      archivedFiles.add(archivedPath);
      if (forbiddenReleasePaths.some((expression) => expression.test(archivedPath))) {
        addFinding(archivedPath, "forbidden legacy or source path");
      }
      const name = basename(path);
      const environmentFile = /\.env(?:\.|$)/iu.test(name) && !/\.env\.example$/iu.test(name);
      if (
        environmentFile ||
        /wallet-backup|private-key|keystore|\.key$|\.(?:pem|p12|pfx)$/iu.test(name)
      ) {
        addFinding(archivedPath, "secret-shaped filename");
      }
      const structuredNameFinding = riskyStructuredFileName(name);
      if (structuredNameFinding !== null) addFinding(archivedPath, structuredNameFinding);
      const metadata = await stat(path);
      if (metadata.size > 1_000_000) continue;
      const body = await readFile(path);
      if (body.includes(0)) continue;
      const contents = body.toString("utf8");
      for (const [rule, expression] of contentRules) {
        if (expression.test(contents)) addFinding(archivedPath, rule);
      }
      scanStructured(archivedPath, contents);
    }
  }
}

async function validateReleaseBinding() {
  const metadataPath = join(temporary, "package/BUILD-METADATA.json");
  const manifestPath = join(temporary, "package/capability-manifest.json");
  const packagePath = join(temporary, "package/package.json");
  const [metadataBody, manifestBody, packageBody] = await Promise.all([
    readFile(metadataPath, "utf8"),
    readFile(manifestPath, "utf8"),
    readFile(packagePath, "utf8"),
  ]);
  const metadata = JSON.parse(metadataBody);
  const manifest = JSON.parse(manifestBody);
  const packageJson = JSON.parse(packageBody);
  if (metadata.schemaVersion !== 2) addFinding("BUILD-METADATA.json", "unsupported schema");
  if (!/^[0-9a-f]{40}$/u.test(metadata.sourceCommit ?? "")) {
    addFinding("BUILD-METADATA.json", "source commit is not a full SHA-1 commit id");
  }
  if (metadata.sourceTreeState !== "CLEAN_EXCEPT_GENERATED_BUILD_METADATA") {
    addFinding("BUILD-METADATA.json", "source tree was not clean at metadata generation");
  }
  if (
    !Number.isSafeInteger(metadata.capabilityManifestRevision) ||
    metadata.capabilityManifestRevision <= 0 ||
    metadata.capabilityManifestRevision !== manifest.manifest_revision
  ) {
    addFinding("BUILD-METADATA.json", "capability manifest revision mismatch");
  }
  const manifestSha256 = createHash("sha256").update(manifestBody).digest("hex");
  if (metadata.capabilityManifestSha256 !== manifestSha256) {
    addFinding("BUILD-METADATA.json", "capability manifest digest mismatch");
  }
  if (
    metadata.packageName !== packageJson.name ||
    metadata.packageVersion !== packageJson.version
  ) {
    addFinding("BUILD-METADATA.json", "package identity mismatch");
  }
  if (Number.isNaN(Date.parse(metadata.generatedAt ?? ""))) {
    addFinding("BUILD-METADATA.json", "generatedAt is not an ISO-compatible timestamp");
  }
}

try {
  execFileSync("tar", ["-xzf", resolve(archive), "-C", temporary], { stdio: "pipe" });
  await walk(temporary);
  for (const requiredFile of requiredFiles) {
    if (!archivedFiles.has(requiredFile)) addFinding(requiredFile, "required release file missing");
  }
  if (requiredFiles.every((requiredFile) => archivedFiles.has(requiredFile))) {
    await validateReleaseBinding();
  }
  if (findings.size > 0) {
    throw new Error(`package audit failed:\n${[...findings.values()].join("\n")}`);
  }
  process.stdout.write(
    `package archive boundary and secret scan passed (${archivedFiles.size} files): ${resolve(archive)}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
  if (packageTemporary !== null) {
    await rm(packageTemporary, { recursive: true, force: true });
  }
}
