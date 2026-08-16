import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const defaultEnvPath = resolve(homedir(), ".Codex", "secrets", "clockin-sniper", "live.env");
const envPath = process.env.CLOCKIN_ENV_FILE?.trim() || defaultEnvPath;

try {
  process.loadEnvFile(envPath);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const privateKeyFile = process.env.CLOCKIN_PRIVATE_KEY_FILE?.trim();
if (process.env.CLOCKIN_PRIVATE_KEY?.trim() === undefined && privateKeyFile !== undefined) {
  const contents = (await readFile(privateKeyFile, "utf8")).trim();
  const labelled = contents.match(/^Private key:\s*(0x[0-9a-fA-F]{64})$/mu)?.[1];
  const privateKey = /^0x[0-9a-fA-F]{64}$/u.test(contents) ? contents : labelled;
  if (privateKey === undefined) {
    throw new Error("CLOCKIN_PRIVATE_KEY_FILE does not contain one valid 32-byte private key");
  }
  process.env.CLOCKIN_PRIVATE_KEY = privateKey;
}
