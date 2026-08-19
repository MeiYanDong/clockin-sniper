import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

const UNIT_BINDINGS = Object.freeze({
  "clockin-control.service.in": Object.freeze({
    placeholder: "@CONTROL_EXECUTABLE@",
    entrypoint: "control-service.js",
  }),
  "clockin-executor.service.in": Object.freeze({
    placeholder: "@EXECUTOR_EXECUTABLE@",
    entrypoint: "stonk-safe-launch-executor-service.js",
  }),
  "clockin-wallet-preparer.service.in": Object.freeze({
    placeholder: "@WALLET_PREPARER_EXECUTABLE@",
    entrypoint: "prepare-stonk-safe-launch-wallets.js",
  }),
  "clockin-reconciler.service.in": Object.freeze({
    placeholder: "@RECONCILER_EXECUTABLE@",
    entrypoint: "reconciler-service.js",
  }),
  "clockin-exit.service.in": Object.freeze({
    placeholder: "@EXIT_EXECUTABLE@",
    entrypoint: "exit-service.js",
  }),
  "clockin-executor.path.in": null,
});

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    throw new Error(`missing required option ${name}`);
  }
  return process.argv[index + 1];
}

function safeAbsolute(value, label) {
  if (!isAbsolute(value) || !/^\/[A-Za-z0-9._/-]+$/u.test(value)) {
    throw new Error(`${label} must be an absolute path without whitespace or shell syntax`);
  }
  return resolve(value);
}

const artifactDir = safeAbsolute(option("--artifact-dir"), "artifact directory");
const nodeExecutable = safeAbsolute(option("--node"), "node executable");
const outputDir = safeAbsolute(option("--output-dir"), "output directory");
const packageDir = join(artifactDir, "clockin-sniper");
const templateDir = resolve(import.meta.dirname, "systemd");

await access(nodeExecutable);
await mkdir(outputDir, { recursive: true, mode: 0o755 });

for (const [templateName, binding] of Object.entries(UNIT_BINDINGS)) {
  const template = await readFile(join(templateDir, templateName), "utf8");
  let rendered = template.replaceAll("@ARTIFACT_DIR@", artifactDir);
  if (binding !== null) {
    const entrypoint = join(packageDir, "dist", binding.entrypoint);
    await access(entrypoint);
    rendered = rendered.replaceAll(binding.placeholder, `${nodeExecutable} ${entrypoint}`);
  }
  const unresolved = rendered.match(/@[A-Z][A-Z_]+@/gu);
  if (unresolved !== null) {
    throw new Error(`${templateName} contains unresolved placeholders: ${unresolved.join(",")}`);
  }
  const output = join(outputDir, basename(templateName, ".in"));
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, rendered, { mode: 0o644, flag: "wx" });
  await rename(temporary, output);
  process.stdout.write(`${output}\n`);
}
