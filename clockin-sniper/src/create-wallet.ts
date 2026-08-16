import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { Wallet } from "ethers";

process.umask(0o077);

const projectRoot = process.cwd();
const secretDirectory = resolve(
  process.env.CLOCKIN_SECRET_DIR?.trim() ||
    resolve(homedir(), ".Codex", "secrets", "clockin-sniper"),
);
const envPath = resolve(secretDirectory, "live.env");
const backupPath = resolve(secretDirectory, "wallet-backup.txt");
const publicPath = resolve(secretDirectory, "wallet.json");

function hasAssignedKey(contents: string, key: string): boolean {
  return contents
    .split(/\r?\n/u)
    .some(
      (line) =>
        line.trimStart().startsWith(`${key}=`) && line.slice(line.indexOf("=") + 1).trim() !== "",
    );
}

function setEnvValue(contents: string, key: string, value: string): string {
  const assignment = `${key}=${value}`;
  const lines = contents.split(/\r?\n/u);
  const index = lines.findIndex((line) => line.trimStart().startsWith(`${key}=`));
  if (index === -1) {
    const prefix = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
    return `${contents}${prefix}${assignment}\n`;
  }
  lines[index] = assignment;
  return `${lines.join("\n").replace(/\n+$/u, "")}\n`;
}

async function assertDoesNotExist(path: string): Promise<void> {
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.close();
    await unlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST")
      throw new Error(`refusing to overwrite existing wallet artifact: ${path}`);
    throw error;
  }
}

const existingEnv = await readFile(envPath, "utf8").catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
if (
  hasAssignedKey(existingEnv, "CLOCKIN_PRIVATE_KEY") ||
  hasAssignedKey(existingEnv, "CLOCKIN_EXPECTED_WALLET_ADDRESS")
) {
  throw new Error("refusing to replace an existing ClockIn wallet configuration");
}

if (secretDirectory === projectRoot || secretDirectory.startsWith(`${projectRoot}/`)) {
  throw new Error("CLOCKIN_SECRET_DIR must be outside the project directory");
}
await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
await chmod(secretDirectory, 0o700);
await Promise.all([assertDoesNotExist(backupPath), assertDoesNotExist(publicPath)]);

const wallet = Wallet.createRandom();
const createdAt = new Date().toISOString();
const backup = [
  "ClockIn dedicated hot wallet",
  `Created: ${createdAt}`,
  `Address: ${wallet.address}`,
  `Private key: ${wallet.privateKey}`,
  "",
  "This key controls the wallet. Move it to your password manager, never paste it into chat,",
  "and fund this address only with the bounded ClockIn execution balance.",
  "",
].join("\n");

const backupHandle = await open(backupPath, "wx", 0o600);
try {
  await backupHandle.writeFile(backup, "utf8");
} finally {
  await backupHandle.close();
}

const publicHandle = await open(publicPath, "wx", 0o600);
try {
  await publicHandle.writeFile(
    `${JSON.stringify({ address: wallet.address, createdAt }, null, 2)}\n`,
    "utf8",
  );
} finally {
  await publicHandle.close();
}

let updatedEnv = setEnvValue(existingEnv, "CLOCKIN_PRIVATE_KEY_FILE", backupPath);
updatedEnv = setEnvValue(updatedEnv, "CLOCKIN_EXPECTED_WALLET_ADDRESS", wallet.address);
const temporaryEnvPath = `${envPath}.wallet-${process.pid}.tmp`;
try {
  await writeFile(temporaryEnvPath, updatedEnv, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryEnvPath, envPath);
  await chmod(envPath, 0o600);
} catch (error) {
  await unlink(temporaryEnvPath).catch(() => undefined);
  throw error;
}

process.stdout.write(
  `${JSON.stringify({ address: wallet.address, backupPath, publicPath, envPath })}\n`,
);
