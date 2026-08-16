import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const systemdRoot = fileURLToPath(new URL("../deploy/systemd/", import.meta.url));
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
      assert.match(unit, /^EnvironmentFile=\/etc\/clockin-sniper\/strategy\.env$/mu, unitName);
      assert.match(unit, /^Restart=on-failure$/mu, unitName);
      assert.match(unit, /^RestartSec=\d+s$/mu, unitName);
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
      assert.match(unit, /^Wants=network-online\.target time-sync\.target$/mu, unitName);
    }
  });

  it("keeps the Control Sentinel keyless and gives it an isolated OS identity", async () => {
    const control = await readUnit("clockin-control.service.in");
    assert.match(control, /^User=clockin-observer$/mu);
    assert.match(control, /^LoadCredential=rpc_http:/mu);
    assert.match(control, /^LoadCredential=rpc_wss:/mu);
    assert.doesNotMatch(control, /wallet|entry_\d|vault_key|private.?key/iu);
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
    }
  });

  it("fails closed until a production readiness receipt authorizes the executor", async () => {
    const executor = await readUnit("clockin-executor.service.in");
    assert.match(
      executor,
      /^ConditionPathExists=\/etc\/clockin-sniper\/PRODUCTION_ARM_APPROVED$/mu,
    );
    assert.match(executor, /^ExecStart=@EXECUTOR_EXECUTABLE@$/mu);
    assert.doesNotMatch(executor, /npm run live(?:\s|$)/u);
  });

  it("defines owner-only secret/state directories and bounded journal retention", async () => {
    const tmpfiles = await readFile(`${systemdRoot}clockin-sniper.tmpfiles.conf`, "utf8");
    assert.match(tmpfiles, /^d \/etc\/clockin-sniper\/credentials 0700 root root -$/mu);
    assert.match(tmpfiles, /^d \/etc\/clockin-sniper\/wallets 0700 root root -$/mu);
    assert.match(tmpfiles, /^d \/var\/lib\/clockin-sniper 0700 clockin clockin -$/mu);

    const journal = await readFile(`${systemdRoot}journald-clockin.conf`, "utf8");
    assert.match(journal, /^SystemMaxUse=1G$/mu);
    assert.match(journal, /^MaxRetentionSec=14day$/mu);
    assert.match(journal, /^Compress=yes$/mu);
    assert.match(journal, /^Seal=yes$/mu);
  });
});
