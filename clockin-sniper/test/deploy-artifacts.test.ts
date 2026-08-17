import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const systemdRoot = fileURLToPath(new URL("../deploy/systemd/", import.meta.url));
const rendererPath = fileURLToPath(new URL("../deploy/render-systemd.mjs", import.meta.url));
const execFileAsync = promisify(execFile);
const unitNames = [
  "clockin-control.service.in",
  "clockin-executor.service.in",
  "clockin-reconciler.service.in",
  "clockin-exit.service.in",
] as const;

async function readUnit(name: (typeof unitNames)[number]): Promise<string> {
  return readFile(`${systemdRoot}${name}`, "utf8");
}

describe("hardened production service templates", () => {
  it("runs every service as a dedicated non-root user with deterministic recovery", async () => {
    for (const unitName of unitNames) {
      const unit = await readUnit(unitName);
      assert.match(unit, /^User=clockin(?:-observer)?$/mu, unitName);
      assert.doesNotMatch(unit, /^User=root$/mu, unitName);
      assert.match(unit, /^WorkingDirectory=@ARTIFACT_DIR@\/clockin-sniper$/mu, unitName);
      if (unitName === "clockin-control.service.in") {
        assert.match(unit, /^EnvironmentFile=-\/etc\/clockin-sniper\/control\.env$/mu, unitName);
      } else {
        assert.match(unit, /^EnvironmentFile=\/etc\/clockin-sniper\/strategy\.env$/mu, unitName);
      }
      assert.match(unit, /^Restart=on-failure$/mu, unitName);
      assert.match(unit, /^RestartSec=\d+s$/mu, unitName);
      assert.match(unit, /^Type=notify$/mu, unitName);
      assert.match(unit, /^NotifyAccess=all$/mu, unitName);
      assert.match(unit, /^WatchdogSec=30s$/mu, unitName);
      assert.match(unit, /^StartLimitIntervalSec=\d+s$/mu, unitName);
      assert.match(unit, /^StartLimitBurst=\d+$/mu, unitName);
      assert.match(unit, /^UMask=0077$/mu, unitName);
      assert.match(unit, /^StateDirectoryMode=0700$/mu, unitName);
      assert.match(unit, /^StandardOutput=journal$/mu, unitName);
      assert.match(unit, /^StandardError=journal$/mu, unitName);
      assert.match(unit, /^NoNewPrivileges=true$/mu, unitName);
      assert.match(unit, /^ProtectSystem=strict$/mu, unitName);
      assert.match(unit, /^ProtectHome=true$/mu, unitName);
      assert.match(unit, /^ProtectProc=invisible$/mu, unitName);
      assert.match(unit, /^CapabilityBoundingSet=$/mu, unitName);
      assert.match(unit, /^SupplementaryGroups=clockin-status$/mu, unitName);
      assert.match(unit, /^ReadWritePaths=.*\/run\/clockin-status$/mu, unitName);
      assert.match(unit, /^Wants=network-online\.target time-sync\.target$/mu, unitName);
    }
  });

  it("keeps the Control Sentinel keyless and gives it an isolated OS identity", async () => {
    const control = await readUnit("clockin-control.service.in");
    assert.match(control, /^User=clockin-observer$/mu);
    assert.match(control, /^EnvironmentFile=-\/etc\/clockin-sniper\/control\.env$/mu);
    assert.doesNotMatch(control, /strategy\.env/u);
    assert.doesNotMatch(control, /^LoadCredential=/mu);
    assert.doesNotMatch(
      control,
      /rpc_http|rpc_wss|sequencer_http|wallet|entry_\d|vault_key|private.?key/iu,
    );
  });

  it("ships a public-only Control environment example without RPC or secret fields", async () => {
    const environment = await readFile(
      fileURLToPath(new URL("../deploy/control.env.example", import.meta.url)),
      "utf8",
    );
    assert.match(environment, /^CLOCKIN_PUBLIC_HEAD_POLL_MS=2000$/mu);
    assert.match(environment, /^CLOCKIN_PUBLIC_IDENTITY_REFRESH_MS=300000$/mu);
    assert.match(environment, /^CLOCKIN_PUBLIC_WALLET_REFRESH_MS=3600000$/mu);
    const variableNames = environment
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.split("=", 1)[0])
      .join("\n");
    assert.doesNotMatch(
      variableNames,
      /rpc|chainstack|credential|secret|private.?key|wallet.?key/iu,
    );
  });

  it("mounts exactly ten one-shot wallet credentials for entry and exit", async () => {
    for (const unitName of ["clockin-executor.service.in", "clockin-exit.service.in"] as const) {
      const unit = await readUnit(unitName);
      const walletCredentials = unit.match(/^LoadCredential=entry_\d{2}:/gmu) ?? [];
      assert.equal(walletCredentials.length, 10, unitName);
      for (let lane = 1; lane <= 10; lane += 1) {
        const id = String(lane).padStart(2, "0");
        assert.match(unit, new RegExp(`^LoadCredential=entry_${id}:`, "mu"), unitName);
      }
      assert.match(unit, /^LoadCredential=vault_key:/mu, unitName);
      assert.match(unit, /^LoadCredential=wallet_manifest:/mu, unitName);
      assert.match(unit, /^LoadCredential=factory_profile:/mu, unitName);
      assert.match(unit, /^LoadCredential=authorization:/mu, unitName);
    }
  });

  it("fails closed until a production readiness receipt authorizes the executor", async () => {
    const executor = await readUnit("clockin-executor.service.in");
    assert.match(
      executor,
      /^ConditionPathExists=\/etc\/clockin-sniper\/PRODUCTION_ARM_APPROVED$/mu,
    );
    assert.match(executor, /^ConditionPathExists=\/etc\/clockin-sniper\/PAID_RPC_APPROVED$/mu);
    assert.match(executor, /^ExecStart=@EXECUTOR_EXECUTABLE@$/mu);
    assert.match(executor, /^Requires=clockin-reconciler\.service clockin-exit\.service$/mu);
    assert.match(executor, /^After=.*clockin-reconciler\.service clockin-exit\.service$/mu);
    assert.doesNotMatch(executor, /npm run live(?:\s|$)/u);
  });

  it("blocks every paid-RPC service until a separate real-snipe cost window is approved", async () => {
    for (const unitName of [
      "clockin-executor.service.in",
      "clockin-reconciler.service.in",
      "clockin-exit.service.in",
    ] as const) {
      const unit = await readUnit(unitName);
      assert.match(
        unit,
        /^ConditionPathExists=\/etc\/clockin-sniper\/PAID_RPC_APPROVED$/mu,
        unitName,
      );
      assert.match(unit, /^LoadCredential=rpc_http:/mu, unitName);
    }
  });

  it("defines owner-only secret/state directories and bounded journal retention", async () => {
    const tmpfiles = await readFile(`${systemdRoot}clockin-sniper.tmpfiles.conf`, "utf8");
    assert.match(tmpfiles, /^d \/etc\/clockin-sniper 0750 root clockin-status -$/mu);
    assert.match(tmpfiles, /^d \/etc\/clockin-sniper\/credentials 0700 root root -$/mu);
    assert.match(tmpfiles, /^d \/etc\/clockin-sniper\/wallets 0700 root root -$/mu);
    assert.match(tmpfiles, /^d \/var\/lib\/clockin-sniper 0700 clockin clockin -$/mu);
    assert.match(tmpfiles, /^d \/run\/clockin-status 3770 root clockin-status -$/mu);

    const journal = await readFile(`${systemdRoot}journald-clockin.conf`, "utf8");
    assert.match(journal, /^SystemMaxUse=1G$/mu);
    assert.match(journal, /^MaxRetentionSec=14day$/mu);
    assert.match(journal, /^Compress=yes$/mu);
    assert.match(journal, /^Seal=yes$/mu);
  });

  it("renders only absolute release entrypoints and rejects unresolved placeholders", async () => {
    const renderer = await readFile(rendererPath, "utf8");
    assert.match(renderer, /safeAbsolute\(option\("--artifact-dir"\), "artifact directory"\)/u);
    assert.match(renderer, /safeAbsolute\(option\("--node"\), "node executable"\)/u);
    assert.match(renderer, /must be an absolute path without whitespace or shell syntax/u);
    assert.match(renderer, /contains unresolved placeholders/isu);
    const root = await mkdtemp(join(tmpdir(), "clockin-systemd-render-"));
    try {
      const artifactDir = join(root, "release");
      const distDir = join(artifactDir, "clockin-sniper", "dist");
      const outputDir = join(root, "units");
      await mkdir(distDir, { recursive: true });
      for (const entrypoint of [
        "control-service.js",
        "executor-service.js",
        "reconciler-service.js",
        "exit-service.js",
      ]) {
        await writeFile(join(distDir, entrypoint), "export {};\n", "utf8");
      }
      await execFileAsync(process.execPath, [
        rendererPath,
        "--artifact-dir",
        artifactDir,
        "--node",
        process.execPath,
        "--output-dir",
        outputDir,
      ]);
      for (const templateName of unitNames) {
        const unit = await readFile(join(outputDir, templateName.replace(/\.in$/u, "")), "utf8");
        assert.doesNotMatch(unit, /@[A-Z][A-Z_]+@/u);
        assert.match(unit, new RegExp(`^WorkingDirectory=${artifactDir}/clockin-sniper$`, "mu"));
        assert.match(unit, new RegExp(`^ExecStart=${process.execPath} ${distDir}/`, "mu"));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
