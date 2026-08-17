import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { ROBINHOOD_PUBLIC_RPC_URL } from "../src/rpc/robinhood.js";
import {
  PAID_RPC_APPROVAL_VALUE,
  validatePaidRpcApproval,
} from "../src/runtime/paid-rpc-approval.js";
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
      throttledRetries: 0,
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
      throttledRetries: 1,
      lastRequestAt: "2026-08-17T07:00:01.500Z",
    });
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
      assert.match(
        source,
        /await assertPaidRpcApproved\(\);\s+const \[[\s\S]+?readSystemdCredential\("rpc_http"\)/u,
        file,
      );
    }
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
