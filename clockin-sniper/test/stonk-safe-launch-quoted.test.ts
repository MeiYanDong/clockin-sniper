import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Interface, keccak256, MaxUint256, ZeroAddress } from "ethers";

import {
  CLOCKIN_APPROVED_LAUNCH_CREATOR,
  CLOCKIN_WETH_SAFE_LAUNCH_PROFILE,
  decodeStonkSafeLaunchQuotedArmed,
  decodeStonkSafeLaunchQuotedCreated,
  isReachableStonkSafeLaunchTaxBps,
  minimumReachableStonkSafeLaunchTaxBps,
  ROBINHOOD_WETH_ADDRESS,
  STONK_SAFE_LAUNCH_QUOTED_BUY_LIMIT_POLICY,
  STONK_SAFE_LAUNCH_QUOTED_ABI,
  STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
  STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
  STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
  STONK_SAFE_LAUNCH_WETH_FACTORY_RUNTIME_CODE_HASH,
  StonkSafeLaunchQuotedAdapter,
  StonkSafeLaunchQuotedPoolRuntime,
  type StonkSafeLaunchQuotedProfile,
  verifyStonkSafeLaunchQuotedProfile,
} from "../src/adapters/stonk-safe-launch-quoted.js";
import type { Address } from "../src/core/canonical.js";
import type { Hex, JsonRpcRequester } from "../src/rpc/types.js";
import type { RpcContractLog } from "../src/rpc/websocket-logs.js";

const abi = new Interface(STONK_SAFE_LAUNCH_QUOTED_ABI);
const TOKEN = "0x1111111111111111111111111111111111111111" as const;
const WALLET = "0x2222222222222222222222222222222222222222" as const;
const HASH = `0x${"ab".repeat(32)}` as Hex;

function logFor(
  eventName: "LaunchCreated" | "LaunchArmed",
  values: readonly unknown[],
  address = STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
): RpcContractLog {
  const fragment = abi.getEvent(eventName);
  if (fragment === null) throw new Error("event is missing");
  const encoded = abi.encodeEventLog(fragment, [...values]);
  return Object.freeze({
    providerId: "test",
    address,
    topics: Object.freeze(encoded.topics as Hex[]),
    data: encoded.data as Hex,
    blockNumber: 123n,
    transactionHash: HASH,
    logIndex: 2n,
    removed: false,
  });
}

function createdLog(creator: Address = CLOCKIN_APPROVED_LAUNCH_CREATOR): RpcContractLog {
  return logFor("LaunchCreated", [7n, TOKEN, creator, false]);
}

function armedLog(): RpcContractLog {
  return logFor("LaunchArmed", [7n, 1_000_000n, 5_000n, 200_000_000_000n, 2_500n]);
}

function launchTuple(overrides: Partial<Record<string, unknown>> = {}): readonly unknown[] {
  const value = {
    token: TOKEN,
    creator: CLOCKIN_APPROVED_LAUNCH_CREATOR,
    startMcapUsd8: 2_500_000_000_000n,
    gradMcapUsd8: 37_500_000_000_000n,
    startTaxBps: 3_300n,
    decayPerMinuteBps: 100n,
    creatorFeeBpsSnap: 500n,
    protocolFeeBpsSnap: 500n,
    windowSecs: 1_980n,
    startTime: 1_000n,
    deadline: 3_280n,
    externalToken: false,
    sellsEnabled: false,
    armed: true,
    graduated: false,
    bonded: false,
    aborted: false,
    loadedSupply: 1_000_000n,
    vQuote: 5_000n,
    vToken: 900_000n,
    realQuote: 0n,
    buyCount: 0n,
    ...overrides,
  };
  return Object.freeze([
    value.token,
    value.creator,
    value.startMcapUsd8,
    value.gradMcapUsd8,
    value.startTaxBps,
    value.decayPerMinuteBps,
    value.creatorFeeBpsSnap,
    value.protocolFeeBpsSnap,
    value.windowSecs,
    value.startTime,
    value.deadline,
    value.externalToken,
    value.sellsEnabled,
    value.armed,
    value.graduated,
    value.bonded,
    value.aborted,
    value.loadedSupply,
    value.vQuote,
    value.vToken,
    value.realQuote,
    value.buyCount,
  ]);
}

function launchViewTuple(oracleFresh: boolean): readonly unknown[] {
  return Object.freeze([
    7n,
    launchTuple(),
    3_300n,
    25_000_000_000n,
    0n,
    oracleFresh,
    [ROBINHOOD_WETH_ADDRESS],
    [],
    [],
    0n,
    0n,
    0n,
    300n,
  ]);
}

class CallRequester implements JsonRpcRequester {
  readonly providerId = "quoted-test";
  readonly #responses: Readonly<Record<string, string>>;

  constructor(responses: Readonly<Record<string, string>>) {
    this.#responses = responses;
  }

  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    if (method !== "eth_call") throw new Error(`unexpected ${method}`);
    const call = params[0] as { readonly data: string };
    const response = this.#responses[call.data.slice(0, 10)];
    if (response === undefined) throw new Error(`unexpected selector ${call.data.slice(0, 10)}`);
    return response as T;
  }
}

describe("verified quoted Safe Launch adapter", () => {
  it("freezes current WETH pad identity and exact event topics", () => {
    assert.equal(
      STONK_SAFE_LAUNCH_QUOTED_CREATED_TOPIC,
      "0xa4d3b2dc54656491295ce21a0b888cd8df38e69113e44371344da5088e480a43",
    );
    assert.equal(
      STONK_SAFE_LAUNCH_QUOTED_ARMED_TOPIC,
      "0x617dff9af409b81e92edd8d62fb192f25509657b96d203585e3e6b605d4dea26",
    );
    assert.equal(CLOCKIN_WETH_SAFE_LAUNCH_PROFILE.quoteAsset, ROBINHOOD_WETH_ADDRESS);
  });

  it("decodes Created/Armed and rejects wrong emitter, layout, removal, and creator binding", () => {
    const created = decodeStonkSafeLaunchQuotedCreated(createdLog());
    const armed = decodeStonkSafeLaunchQuotedArmed(armedLog());
    assert.equal(created.id, 7n);
    assert.equal(created.tokenAddress, TOKEN);
    assert.equal(
      created.creatorAddress.toLowerCase(),
      CLOCKIN_APPROVED_LAUNCH_CREATOR.toLowerCase(),
    );
    assert.equal(armed.id, created.id);
    assert.equal(armed.virtualQuoteInitial, 5_000n);
    assert.throws(
      () =>
        decodeStonkSafeLaunchQuotedCreated({
          ...createdLog(),
          address: "0x3333333333333333333333333333333333333333",
        }),
      /emitter is not the bound pad/,
    );
    assert.throws(
      () => decodeStonkSafeLaunchQuotedCreated({ ...createdLog(), removed: true }),
      /not canonical/,
    );
    assert.throws(() => decodeStonkSafeLaunchQuotedCreated(armedLog()), /topic\/layout is invalid/);
    assert.throws(
      () =>
        new StonkSafeLaunchQuotedPoolRuntime({
          requester: new CallRequester({}),
          created: decodeStonkSafeLaunchQuotedCreated(
            createdLog("0x4444444444444444444444444444444444444444"),
          ),
          armed,
          profileRevision: 1,
        }),
      /creator is not approved/,
    );
  });

  it("reads dynamic launch tax/window fields instead of hardcoding 40%/120s", async () => {
    const requester = new CallRequester({
      [abi.getFunction("getLaunch")?.selector ?? ""]: abi.encodeFunctionResult("getLaunch", [
        launchTuple(),
      ]),
      [abi.getFunction("bufferSecsOf")?.selector ?? ""]: abi.encodeFunctionResult("bufferSecsOf", [
        300n,
      ]),
    });
    const state = await new StonkSafeLaunchQuotedAdapter(requester).readLaunch(7n, 123n);
    assert.equal(state.startTaxBps, 3_300);
    assert.equal(state.decayPerMinuteBps, 100);
    assert.equal(state.windowSeconds, 1_980);
    assert.equal(state.bufferSeconds, 300);
    assert.equal(state.sellsEnabled, false);
    assert.equal(minimumReachableStonkSafeLaunchTaxBps(state), 100);
    assert.equal(isReachableStonkSafeLaunchTaxBps(state, 100), true);
    assert.equal(isReachableStonkSafeLaunchTaxBps(state, 0), false);

    assert.equal(
      minimumReachableStonkSafeLaunchTaxBps({ ...state, windowSeconds: 2_040, deadline: 3_340n }),
      0,
    );
    assert.equal(
      isReachableStonkSafeLaunchTaxBps({ ...state, windowSeconds: 2_040, deadline: 3_340n }, 0),
      true,
    );
    assert.equal(
      minimumReachableStonkSafeLaunchTaxBps({ ...state, windowSeconds: 1_920, deadline: 3_220n }),
      200,
    );
    assert.equal(
      minimumReachableStonkSafeLaunchTaxBps({
        ...state,
        decayPerMinuteBps: 128,
        windowSeconds: 1_560,
        deadline: 2_860n,
      }),
      100,
    );

    const inconsistent = new CallRequester({
      [abi.getFunction("getLaunch")?.selector ?? ""]: abi.encodeFunctionResult("getLaunch", [
        launchTuple({ windowSecs: 120n }),
      ]),
      [abi.getFunction("bufferSecsOf")?.selector ?? ""]: abi.encodeFunctionResult("bufferSecsOf", [
        300n,
      ]),
    });
    await assert.rejects(
      new StonkSafeLaunchQuotedAdapter(inconsistent).readLaunch(7n, 123n),
      /deadline is inconsistent/,
    );
  });

  it("encodes verified no-cap and no-cooldown source semantics without UNKNOWN", async () => {
    const runtime = new StonkSafeLaunchQuotedPoolRuntime({
      requester: new CallRequester({}),
      created: decodeStonkSafeLaunchQuotedCreated(createdLog()),
      armed: decodeStonkSafeLaunchQuotedArmed(armedLog()),
      profileRevision: 1,
    });
    assert.deepEqual(await runtime.readCap(123n), {
      value: MaxUint256,
      scope: "NO_CAP",
    });
    assert.deepEqual(await runtime.readCooldown(123n), {
      seconds: 0,
      scope: "NONE",
    });
    assert.equal(
      STONK_SAFE_LAUNCH_QUOTED_BUY_LIMIT_POLICY.evidenceRuntimeCodeHash,
      STONK_SAFE_LAUNCH_WETH_FACTORY_RUNTIME_CODE_HASH,
    );
  });

  it("reads and requires the exact-block protocol oracle freshness bit", async () => {
    const selector = abi.getFunction("viewLaunch")?.selector ?? "";
    const fresh = new StonkSafeLaunchQuotedAdapter(
      new CallRequester({
        [selector]: abi.encodeFunctionResult("viewLaunch", [launchViewTuple(true)]),
      }),
    );
    const stale = new StonkSafeLaunchQuotedAdapter(
      new CallRequester({
        [selector]: abi.encodeFunctionResult("viewLaunch", [launchViewTuple(false)]),
      }),
    );
    assert.equal(await fresh.oracleFresh(7n, 123n), true);
    assert.equal(await stale.oracleFresh(7n, 123n), false);
  });

  it("quotes exact tax, checks pre-funded allowance, and builds nonpayable direct EOA buy", async () => {
    const requester = new CallRequester({
      [abi.getFunction("quoteBuy")?.selector ?? ""]: abi.encodeFunctionResult("quoteBuy", [
        700n,
        3_300n,
      ]),
      [abi.getFunction("currentTaxBps")?.selector ?? ""]: abi.encodeFunctionResult(
        "currentTaxBps",
        [3_300n],
      ),
      [new Interface(["function balanceOf(address) view returns (uint256)"]).getFunction(
        "balanceOf",
      )?.selector ?? ""]: new Interface([
        "function balanceOf(address) view returns (uint256)",
      ]).encodeFunctionResult("balanceOf", [5_000n]),
      [new Interface(["function allowance(address,address) view returns (uint256)"]).getFunction(
        "allowance",
      )?.selector ?? ""]: new Interface([
        "function allowance(address,address) view returns (uint256)",
      ]).encodeFunctionResult("allowance", [5_000n]),
    });
    const adapter = new StonkSafeLaunchQuotedAdapter(requester);
    assert.deepEqual(await adapter.quoteBuy(7n, 5_000n, 123n), {
      id: 7n,
      quoteIn: 5_000n,
      tokensOut: 700n,
      taxBps: 3_300,
      blockNumber: 123n,
    });
    assert.equal(await adapter.currentTaxBps(7n, 123n), 3_300);
    const readiness = await adapter.spendReadiness(WALLET, 5_000n, 123n);
    assert.equal(readiness.ready, true);
    const calldata = adapter.buildBuy(7n, 5_000n, 650n, HASH);
    assert.equal(calldata.slice(0, 10), "0x4aaf6fa4");
    assert.deepEqual(abi.decodeFunctionData("buy", calldata).toArray(), [7n, 5_000n, 650n, HASH]);
  });

  it("verifies pad/quote runtime and quote() binding", async () => {
    const factoryCode = "0x6001600055";
    const quoteCode = "0x6002600055";
    const profile: StonkSafeLaunchQuotedProfile = Object.freeze({
      factoryAddress: STONK_SAFE_LAUNCH_WETH_FACTORY_ADDRESS,
      factoryRuntimeCodeHash: keccak256(factoryCode) as Hex,
      quoteAsset: ROBINHOOD_WETH_ADDRESS,
      quoteAssetRuntimeCodeHash: keccak256(quoteCode) as Hex,
      startBlock: 1n,
    });
    const requester: JsonRpcRequester = {
      providerId: "verify-test",
      async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
        if (method === "eth_getCode") {
          const address = String(params[0]).toLowerCase();
          return (address === profile.factoryAddress.toLowerCase() ? factoryCode : quoteCode) as T;
        }
        if (method === "eth_call") {
          return abi.encodeFunctionResult("quote", [profile.quoteAsset]) as T;
        }
        if (method === "eth_blockNumber") return "0x7b" as T;
        throw new Error(`unexpected ${method}`);
      },
    };
    await verifyStonkSafeLaunchQuotedProfile(requester, profile, 123n);
    await assert.rejects(
      verifyStonkSafeLaunchQuotedProfile(
        requester,
        { ...profile, quoteAsset: ZeroAddress as `0x${string}` },
        123n,
      ),
      /must not be zero|quote asset changed/,
    );
  });
});
