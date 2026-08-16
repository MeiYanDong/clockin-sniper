import assert from "node:assert/strict";
import test from "node:test";

import { Interface, ZeroAddress } from "ethers";

import {
  TOKEN_LAUNCHED_TOPIC,
  buildNativeBuyCallData,
  decodeTokenLaunchedLog,
  evaluateLaunchIdentity,
  readStonkPoolSnapshot,
  type Hex,
  type JsonRpcRequester,
  type RpcContractLog,
} from "../src/index.js";

const FACTORY = `0x${"10".repeat(20)}` as Hex;
const CREATOR = `0x${"20".repeat(20)}` as Hex;
const TOKEN = `0x${"11".repeat(17)}666666` as Hex;
const POOL = `0x${"30".repeat(20)}` as Hex;
const TX_HASH = `0x${"40".repeat(32)}` as Hex;
const factoryAbi = new Interface([
  "event TokenLaunched(address indexed creator,address indexed memeToken,address indexed pool,string name,string symbol,string metadataURI,bytes32 imageHash)",
]);
const poolAbi = new Interface([
  "function buy(uint256 minTokensOut, bytes32 refCode) payable returns (uint256)",
  "function currentFeeBps() view returns (uint16)",
  "function inSniperWindow() view returns (bool)",
  "function windowMaxBuyBps() view returns (uint16)",
  "function currentWindowCap() view returns (uint256)",
  "function buyCooldownSecs() view returns (uint32)",
  "function eoaOnlySecs() view returns (uint32)",
  "function quoteAsset() view returns (address)",
]);

function launchLog(): RpcContractLog {
  const encoded = factoryAbi.encodeEventLog("TokenLaunched", [
    CREATOR,
    TOKEN,
    POOL,
    "ClockIn",
    "CLOCKIN",
    "https://clockin.win/token.json",
    `0x${"ab".repeat(32)}`,
  ]);
  return Object.freeze({
    address: FACTORY,
    topics: encoded.topics as readonly Hex[],
    data: encoded.data as Hex,
    blockNumber: 100n,
    transactionHash: TX_HASH,
    logIndex: 2n,
    removed: false,
  });
}

test("binds the exact Stonk TokenLaunched event and decodes immutable token/pool identity", () => {
  assert.equal(
    TOKEN_LAUNCHED_TOPIC,
    "0xf78f0cef8c18ef5bdb3e56eb83e296cb35e6968115d16e0ca1891042792e8161",
  );
  const candidate = decodeTokenLaunchedLog(launchLog(), "backfill");
  assert.equal(candidate.creator, CREATOR);
  assert.equal(candidate.tokenAddress, TOKEN);
  assert.equal(candidate.poolAddress, POOL);
  assert.equal(candidate.name, "ClockIn");
  assert.equal(candidate.symbol, "CLOCKIN");
  assert.equal(candidate.source, "backfill");

  assert.deepEqual(
    evaluateLaunchIdentity(candidate, {
      factoryAddress: FACTORY,
      expectedCreator: CREATOR,
      expectedName: "clock-in",
      expectedSymbol: "clockin",
      metadataIncludes: "clockin.win",
      requiredTokenSuffix: "666666",
    }),
    { accepted: true, reasons: [] },
  );
  assert.deepEqual(
    evaluateLaunchIdentity(candidate, {
      factoryAddress: FACTORY,
      expectedCreator: `0x${"99".repeat(20)}`,
      expectedName: "ClockIn",
      expectedSymbol: "CLOCKIN",
      requiredTokenSuffix: "123456",
    }),
    { accepted: false, reasons: ["creator_mismatch", "token_suffix_mismatch"] },
  );
});

test("builds the official payable buy(minTokensOut,refCode) calldata", () => {
  const refCode = `0x${"12".repeat(32)}` as Hex;
  const data = buildNativeBuyCallData(123n, refCode);
  const parsed = poolAbi.parseTransaction({ data });
  assert.equal(parsed?.name, "buy");
  assert.equal(parsed?.args[0], 123n);
  assert.equal(parsed?.args[1], refCode);
});

test("reads actual fee, cooldown, wallet cap, EOA window and quote asset at one block", async () => {
  const requester: JsonRpcRequester = {
    providerId: "pool-rpc",
    async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      assert.equal(method, "eth_call");
      assert.equal(params[1], "0x64");
      const call = params[0] as { readonly to: string; readonly data: string };
      assert.equal(call.to, POOL);
      const parsed = poolAbi.parseTransaction({ data: call.data });
      switch (parsed?.name) {
        case "currentFeeBps":
          return poolAbi.encodeFunctionResult("currentFeeBps", [4_000]) as T;
        case "inSniperWindow":
          return poolAbi.encodeFunctionResult("inSniperWindow", [true]) as T;
        case "windowMaxBuyBps":
          return poolAbi.encodeFunctionResult("windowMaxBuyBps", [200]) as T;
        case "currentWindowCap":
          return poolAbi.encodeFunctionResult("currentWindowCap", [20_000_000n]) as T;
        case "buyCooldownSecs":
          return poolAbi.encodeFunctionResult("buyCooldownSecs", [20]) as T;
        case "eoaOnlySecs":
          return poolAbi.encodeFunctionResult("eoaOnlySecs", [90]) as T;
        case "quoteAsset":
          return poolAbi.encodeFunctionResult("quoteAsset", [ZeroAddress]) as T;
        default:
          throw new Error(`unexpected call ${parsed?.name}`);
      }
    },
  };

  const snapshot = await readStonkPoolSnapshot(requester, POOL, 100n);
  assert.equal(snapshot.currentFeeBps, 4_000);
  assert.equal(snapshot.inSniperWindow, true);
  assert.equal(snapshot.windowMaxBuyBps, 200);
  assert.equal(snapshot.currentWindowCap, 20_000_000n);
  assert.equal(snapshot.buyCooldownSecs, 20);
  assert.equal(snapshot.eoaOnlySecs, 90);
  assert.equal(snapshot.quoteAsset, ZeroAddress);
});
