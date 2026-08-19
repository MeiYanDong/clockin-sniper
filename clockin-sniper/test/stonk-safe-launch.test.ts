import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Interface, ZeroAddress } from "ethers";
import type { Hex, JsonRpcRequester } from "../src/rpc/types.js";
import type { RpcContractLog } from "../src/rpc/websocket-logs.js";
import {
  decodeStonkSafeLaunchArmed,
  decodeStonkSafeLaunchCreated,
  decodeStonkSafeLaunchEvent,
  STONK_SAFE_LAUNCH_ABI,
  STONK_SAFE_LAUNCH_ARMED_TOPIC,
  STONK_SAFE_LAUNCH_CREATED_TOPIC,
  STONK_SAFE_LAUNCH_FACTORY_ADDRESS,
  STONK_SAFE_LAUNCH_FACTORY_RUNTIME_CODE_HASH,
  StonkSafeLaunchAdapter,
} from "../src/v2-index.js";

const TOKEN = `0x${"11".repeat(20)}` as Hex;
const CREATOR = `0x${"22".repeat(20)}` as Hex;
const STONK = `0x${"33".repeat(20)}` as Hex;
const OTHER = `0x${"44".repeat(20)}` as Hex;
const TX_HASH = `0x${"55".repeat(32)}` as Hex;
const REF = `0x${"66".repeat(32)}` as Hex;
const verifiedInterface = new Interface(STONK_SAFE_LAUNCH_ABI);

function logFor(
  eventName: "LaunchCreated" | "LaunchArmed",
  values: readonly unknown[],
): RpcContractLog {
  const encoded = verifiedInterface.encodeEventLog(eventName, [...values]);
  return Object.freeze({
    address: STONK_SAFE_LAUNCH_FACTORY_ADDRESS,
    topics: encoded.topics as readonly Hex[],
    data: encoded.data as Hex,
    blockNumber: 123n,
    transactionHash: TX_HASH,
    logIndex: 7n,
    removed: false,
  });
}

function createdLog(id = 9n): RpcContractLog {
  return logFor("LaunchCreated", [id, TOKEN, CREATOR, false, [ZeroAddress, STONK]]);
}

function armedLog(id = 9n): RpcContractLog {
  return logFor("LaunchArmed", [id, 1_000_000n, 25_000n, 345_678_900_000n, 9_999_999n]);
}

describe("verified Stonk Safe Launch mainnet adapter", () => {
  it("freezes the verified Factory identity and real event topics", () => {
    assert.equal(STONK_SAFE_LAUNCH_FACTORY_ADDRESS, "0xEcA5726dae1e53365c37fFc02369d947A91d71f9");
    assert.equal(
      STONK_SAFE_LAUNCH_FACTORY_RUNTIME_CODE_HASH,
      "0xea44430fca3e9fe18dd54972bcf0a843e3582a6a740027b7fa49e5631809175d",
    );
    assert.equal(
      STONK_SAFE_LAUNCH_CREATED_TOPIC,
      "0xb92439da7ded7e4674a678d544548e707b1d4a4fb4b3946557874ea4d25ba609",
    );
    assert.equal(
      STONK_SAFE_LAUNCH_ARMED_TOPIC,
      "0x617dff9af409b81e92edd8d62fb192f25509657b96d203585e3e6b605d4dea26",
    );
  });

  it("decodes LaunchCreated and LaunchArmed under the verified ABI", () => {
    const created = decodeStonkSafeLaunchCreated(createdLog());
    assert.equal(created.kind, "LaunchCreated");
    assert.equal(created.id, 9n);
    assert.equal(created.tokenAddress, TOKEN);
    assert.equal(created.creatorAddress, CREATOR);
    assert.equal(created.externalToken, false);
    assert.deepEqual(created.legs, [ZeroAddress, STONK]);

    const armed = decodeStonkSafeLaunchArmed(armedLog());
    assert.equal(armed.kind, "LaunchArmed");
    assert.equal(armed.id, 9n);
    assert.equal(armed.supply, 1_000_000n);
    assert.equal(armed.virtualEthInitial, 25_000n);
    assert.equal(armed.ethUsd8, 345_678_900_000n);
    assert.equal(armed.deadline, 9_999_999n);
    assert.equal(decodeStonkSafeLaunchEvent(armedLog()).kind, "LaunchArmed");
  });

  it("rejects removed logs, a wrong emitter, a wrong topic and launch id zero", () => {
    assert.throws(
      () => decodeStonkSafeLaunchCreated(Object.freeze({ ...createdLog(), removed: true })),
      /not canonical/,
    );
    assert.throws(
      () => decodeStonkSafeLaunchCreated(Object.freeze({ ...createdLog(), address: OTHER })),
      /emitter is not/,
    );
    assert.throws(() => decodeStonkSafeLaunchCreated(armedLog()), /topic does not match/);
    assert.throws(() => decodeStonkSafeLaunchCreated(createdLog(0n)), /launch id must be positive/);
  });

  it("reads tuple quotes and current tax at the requested exact block", async () => {
    const observedCalls: string[] = [];
    const requester: JsonRpcRequester = {
      providerId: "verified-factory-fixture",
      async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
        assert.equal(method, "eth_call");
        assert.equal(params[1], "0x7b");
        const call = params[0] as { readonly to: string; readonly data: string };
        assert.equal(call.to, STONK_SAFE_LAUNCH_FACTORY_ADDRESS);
        const parsed = verifiedInterface.parseTransaction({ data: call.data });
        if (parsed === null) throw new Error("call did not decode");
        observedCalls.push(parsed.name);
        if (parsed.name === "quoteBuy") {
          assert.deepEqual([...parsed.args], [9n, 5_000n]);
          return verifiedInterface.encodeFunctionResult("quoteBuy", [12_345n, 4_000n]) as T;
        }
        if (parsed.name === "currentTaxBps") {
          assert.deepEqual([...parsed.args], [9n]);
          return verifiedInterface.encodeFunctionResult("currentTaxBps", [3_900n]) as T;
        }
        throw new Error(`unexpected call ${parsed.name}`);
      },
    };
    const adapter = new StonkSafeLaunchAdapter(requester);
    assert.deepEqual(await adapter.quoteBuy(9n, 5_000n, 123n), {
      id: 9n,
      ethIn: 5_000n,
      tokensOut: 12_345n,
      taxBps: 4_000,
      blockNumber: 123n,
    });
    assert.equal(await adapter.currentTaxBps(9n, 123n), 3_900);
    assert.deepEqual(observedCalls, ["quoteBuy", "currentTaxBps"]);
  });

  it("rejects a non-executable tuple quote and an invalid tax output", async () => {
    const response = (tokensOut: bigint, tax: bigint): JsonRpcRequester => ({
      providerId: "invalid-output-fixture",
      async request<T>(): Promise<T> {
        return verifiedInterface.encodeFunctionResult("quoteBuy", [tokensOut, tax]) as T;
      },
    });
    await assert.rejects(
      new StonkSafeLaunchAdapter(response(0n, 4_000n)).quoteBuy(9n, 5_000n, 123n),
      /tokensOut must be positive/,
    );
    await assert.rejects(
      new StonkSafeLaunchAdapter(response(10n, 10_001n)).quoteBuy(9n, 5_000n, 123n),
      /taxBps exceeds 10000/,
    );
  });

  it("builds the verified payable buy(id,minTokensOut,ref) calldata", () => {
    const adapter = new StonkSafeLaunchAdapter({
      providerId: "unused",
      request: async () => {
        throw new Error("unexpected RPC call");
      },
    });
    const template = adapter.buildBuy(9n, 123n, REF);
    assert.equal(template.target, STONK_SAFE_LAUNCH_FACTORY_ADDRESS);
    assert.equal(template.payable, true);
    const parsed = verifiedInterface.parseTransaction({ data: template.calldata });
    assert.equal(parsed?.name, "buy");
    assert.deepEqual(parsed === null ? [] : [...parsed.args], [9n, 123n, REF]);
    assert.equal(template.calldata.slice(0, 10), "0x053a64e7");

    assert.throws(() => adapter.buildBuy(0n, 123n, REF), /launch id must be positive/);
    assert.throws(() => adapter.buildBuy(9n, 0n, REF), /minTokensOut must be positive/);
    assert.throws(() => adapter.buildBuy(9n, 123n, "0x12"), /must be bytes32/);
  });
});
