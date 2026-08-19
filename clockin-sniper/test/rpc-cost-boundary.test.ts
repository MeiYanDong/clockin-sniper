import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { ROBINHOOD_PUBLIC_RPC_URL } from "../src/rpc/robinhood.js";
import {
  PAID_RPC_APPROVAL_VALUE,
  validatePaidRpcApproval,
} from "../src/runtime/paid-rpc-approval.js";
import {
  PRODUCTION_ARM_APPROVAL_VALUE,
  validateProductionArmApproval,
} from "../src/runtime/production-arm-approval.js";
import { PublicControlRpc } from "../src/runtime/public-control-rpc.js";

describe("public Control RPC cost boundary", () => {
  it("cannot be configured away from the official public endpoint and records method usage", async () => {
    const destinations: string[] = [];
    let now = Date.parse("2026-08-17T07:00:00.000Z");
    const fetchFn: typeof fetch = async (input, init) => {
      destinations.push(String(input));
      const request = JSON.parse(String(init?.body)) as {
        readonly id: number;
        readonly method: string;
      };
      const result = request.method === "eth_chainId" ? "0x1237" : "0x10";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const rpc = new PublicControlRpc({ fetchFn, now: () => now });
    assert.equal(await rpc.request("eth_chainId"), "0x1237");
    now += 2_000;
    assert.equal(await rpc.request("eth_blockNumber"), "0x10");
    assert.deepEqual(destinations, [ROBINHOOD_PUBLIC_RPC_URL, ROBINHOOD_PUBLIC_RPC_URL]);
    assert.deepEqual(rpc.usageSnapshot(), {
      providerId: "robinhood-public-http",
      endpointClass: "OFFICIAL_PUBLIC_HTTP",
      totalRequests: 2,
      requestsByMethod: { eth_blockNumber: 1, eth_chainId: 1 },
      requestsByPriority: { foreground: 2, background: 0 },
      throttledRetries: 0,
      pendingForeground: 0,
      pendingBackground: 0,
      maximumBackgroundQueueDepth: 0,
      lastRequestAt: "2026-08-17T07:00:02.000Z",
    });
  });

  it("serializes public calls and retries HTTP 429 with bounded backoff", async () => {
    let now = Date.parse("2026-08-17T07:00:00.000Z");
    let attempts = 0;
    const delays: number[] = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      attempts += 1;
      if (attempts === 1) return new Response("rate limited", { status: 429 });
      const request = JSON.parse(String(init?.body)) as {
        readonly id: number;
        readonly method: string;
      };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: request.method === "eth_chainId" ? "0x1237" : "0x10",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const rpc = new PublicControlRpc({
      fetchFn,
      now: () => now,
      minimumIntervalMs: 500,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
    });
    const [block, chainId] = await Promise.all([
      rpc.request("eth_blockNumber"),
      rpc.request("eth_chainId"),
    ]);
    assert.equal(block, "0x10");
    assert.equal(chainId, "0x1237");
    assert.deepEqual(delays, [1_000, 500]);
    assert.deepEqual(rpc.usageSnapshot(), {
      providerId: "robinhood-public-http",
      endpointClass: "OFFICIAL_PUBLIC_HTTP",
      totalRequests: 3,
      requestsByMethod: { eth_blockNumber: 2, eth_chainId: 1 },
      requestsByPriority: { foreground: 3, background: 0 },
      throttledRetries: 1,
      pendingForeground: 0,
      pendingBackground: 0,
      maximumBackgroundQueueDepth: 0,
      lastRequestAt: "2026-08-17T07:00:01.500Z",
    });
  });

  it("serves a new head request before queued background readiness work", async () => {
    const calls: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchFn: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        readonly id: number;
        readonly method: string;
      };
      calls.push(request.method);
      if (request.method === "background-a") {
        markFirstStarted?.();
        await firstGate;
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const rpc = new PublicControlRpc({ fetchFn, minimumIntervalMs: 1 });
    const first = rpc.requestBackground<string>("background-a");
    await firstStarted;
    const second = rpc.requestBackground<string>("background-b");
    const head = rpc.request<string>("eth_blockNumber");
    releaseFirst?.();
    assert.deepEqual(await Promise.all([first, second, head]), [
      "background-a",
      "background-b",
      "eth_blockNumber",
    ]);
    assert.deepEqual(calls, ["background-a", "eth_blockNumber", "background-b"]);
    const usage = rpc.usageSnapshot();
    assert.deepEqual(usage.requestsByPriority, { foreground: 1, background: 2 });
    assert.equal(usage.maximumBackgroundQueueDepth, 1);
    assert.equal(usage.pendingForeground, 0);
    assert.equal(usage.pendingBackground, 0);
  });

  it("keeps paid credentials out of the Control source and unit", async () => {
    const [source, unit] = await Promise.all([
      readFile(new URL("../src/control-service.ts", import.meta.url), "utf8"),
      readFile(new URL("../deploy/systemd/clockin-control.service.in", import.meta.url), "utf8"),
    ]);
    for (const forbidden of ["rpc_http", "rpc_wss", "sequencer_http", "readSystemdCredential"]) {
      assert.doesNotMatch(source, new RegExp(forbidden, "u"), forbidden);
      assert.doesNotMatch(unit, new RegExp(forbidden, "u"), forbidden);
    }
    assert.doesNotMatch(unit, /^LoadCredential=/mu);
  });

  it("does not let an aligned head poll suppress the periodic chain-identity check", async () => {
    const source = await readFile(new URL("../src/control-service.ts", import.meta.url), "utf8");
    assert.match(source, /let headPollRunning = false;/u);
    assert.match(source, /let identityCheckRunning = false;/u);
    assert.match(source, /if \(identityCheckRunning \|\| stopping\) return;/u);
    assert.match(source, /if \(headPollRunning \|\| stopping\) return;/u);
    assert.doesNotMatch(source, /chainPollRunning/u);
  });

  it("checks paid approval before any paid service loads credentials", async () => {
    for (const file of ["executor-service.ts", "reconciler-service.ts", "exit-service.ts"]) {
      const source = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
      const approvalIndex = source.indexOf("await assertPaidRpcApproved();");
      const credentialIndex = source.indexOf('readSystemdCredential("rpc_http")');
      assert.ok(approvalIndex >= 0 && credentialIndex > approvalIndex, file);
    }
  });

  it("checks production arm approval before the executor reads any signer", async () => {
    const source = await readFile(new URL("../src/executor-service.ts", import.meta.url), "utf8");
    const approvalIndex = source.indexOf("await assertProductionArmApproved();");
    const signerIndex = source.indexOf("loadProductionWalletSigners()");
    assert.ok(approvalIndex >= 0 && signerIndex > approvalIndex);
  });

  it("continuously gates reconciler paid work and same-raw replay on both live approvals", async () => {
    const source = await readFile(new URL("../src/reconciler-service.ts", import.meta.url), "utf8");
    const mainIndex = source.indexOf("async function main(): Promise<void>");
    const credentialIndex = source.indexOf('readSystemdCredential("rpc_http")', mainIndex);
    const paidStartupIndex = source.indexOf("await assertPaidRpcApproved();", mainIndex);
    const armStartupIndex = source.indexOf("await assertProductionArmApproved();", mainIndex);
    assert.ok(mainIndex >= 0);
    assert.ok(paidStartupIndex > mainIndex && paidStartupIndex < credentialIndex);
    assert.ok(armStartupIndex > paidStartupIndex && armStartupIndex < credentialIndex);
    assert.match(source, /beforeBroadcast: assertRuntimeApprovals/u);
    assert.match(
      source,
      /const tick = async \(\): Promise<string \| null> => \{[\s\S]*await assertRuntimeApprovals\(\);/u,
    );
    assert.match(source, /stopping = true;[\s\S]*clearInterval\(timer\)/u);
    assert.match(source, /writeStatus\("FAILED", \["RUNTIME_APPROVAL_REVOKED", reason\]\)/u);
    assert.match(source, /process\.exitCode = 1;/u);
  });

  it("continuously gates Exit startup, ticks, signing and broadcast on both live approvals", async () => {
    const source = await readFile(new URL("../src/exit-service.ts", import.meta.url), "utf8");
    const mainIndex = source.indexOf("async function main(): Promise<void>");
    const startupApprovalIndex = source.indexOf("await assertRuntimeApprovals();", mainIndex);
    const credentialIndex = source.indexOf('readSystemdCredential("rpc_http")', mainIndex);
    assert.ok(mainIndex >= 0);
    assert.ok(startupApprovalIndex > mainIndex && startupApprovalIndex < credentialIndex);

    const tickIndex = source.indexOf("const tick = async (): Promise<void>", mainIndex);
    const tickApprovalIndex = source.indexOf("await assertRuntimeApprovals();", tickIndex);
    const tickRpcIndex = source.indexOf('canonical.request<string>("eth_blockNumber")', tickIndex);
    assert.ok(tickIndex > mainIndex);
    assert.ok(tickApprovalIndex > tickIndex && tickApprovalIndex < tickRpcIndex);

    const submitIndex = source.indexOf("const submit = async", mainIndex);
    const signingIndex = source.indexOf("input.signer.signer.signTransaction", submitIndex);
    const signingApprovalIndex = source.lastIndexOf(
      "await assertRuntimeApprovals();",
      signingIndex,
    );
    const broadcastIndex = source.indexOf("broadcaster.broadcast(raw)", signingIndex);
    const broadcastApprovalIndex = source.lastIndexOf(
      "await assertRuntimeApprovals();",
      broadcastIndex,
    );
    assert.ok(signingApprovalIndex > submitIndex && signingApprovalIndex < signingIndex);
    assert.ok(broadcastApprovalIndex > signingIndex && broadcastApprovalIndex < broadcastIndex);
    assert.match(source, /runtime approval revoked; paid exit lifecycle stopped/u);
    assert.match(source, /stop\("RUNTIME_APPROVAL_REVOKED", "FAILED"/u);
    assert.match(source, /if \(tickTimer !== null\) clearInterval\(tickTimer\)/u);
    assert.match(source, /if \(approvalTimer !== null\) clearInterval\(approvalTimer\)/u);
  });
});

describe("paid RPC approval marker", () => {
  it("accepts only an exact root-owned non-writable marker", () => {
    assert.doesNotThrow(() =>
      validatePaidRpcApproval(`${PAID_RPC_APPROVAL_VALUE}\n`, {
        isFile: true,
        uid: 0,
        mode: 0o100640,
      }),
    );
    assert.throws(
      () =>
        validatePaidRpcApproval(PAID_RPC_APPROVAL_VALUE, {
          isFile: true,
          uid: 501,
          mode: 0o100640,
        }),
      /owned by root/,
    );
    assert.throws(
      () =>
        validatePaidRpcApproval(PAID_RPC_APPROVAL_VALUE, {
          isFile: true,
          uid: 0,
          mode: 0o100660,
        }),
      /group\/world writable/,
    );
    assert.throws(
      () => validatePaidRpcApproval("wrong", { isFile: true, uid: 0, mode: 0o100640 }),
      /invalid value/,
    );
  });
});

describe("production arm approval marker", () => {
  it("accepts only an exact root-owned non-writable marker", () => {
    assert.doesNotThrow(() =>
      validateProductionArmApproval(`${PRODUCTION_ARM_APPROVAL_VALUE}\n`, {
        isFile: true,
        uid: 0,
        mode: 0o100640,
      }),
    );
    assert.throws(
      () =>
        validateProductionArmApproval(PRODUCTION_ARM_APPROVAL_VALUE, {
          isFile: true,
          uid: 501,
          mode: 0o100640,
        }),
      /owned by root/,
    );
    assert.throws(
      () =>
        validateProductionArmApproval(PRODUCTION_ARM_APPROVAL_VALUE, {
          isFile: true,
          uid: 0,
          mode: 0o100660,
        }),
      /group\/world writable/,
    );
    assert.throws(
      () =>
        validateProductionArmApproval("wrong", {
          isFile: true,
          uid: 0,
          mode: 0o100640,
        }),
      /invalid value/,
    );
  });
});
