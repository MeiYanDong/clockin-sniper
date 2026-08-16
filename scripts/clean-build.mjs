import { rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

const target = resolve(import.meta.dirname, "../clockin-sniper/dist");
if (basename(target) !== "dist" || !target.includes("clockin-sniper")) {
  throw new Error(`refusing to clean unexpected build directory: ${target}`);
}
await rm(target, { recursive: true, force: true });
