import { Interface, getAddress, isHexString } from "ethers";

import type { RecoveryProbeSnapshot, UnknownRecoveryProbe } from "../broadcast/unknown-recovery.js";
import type {
  BroadcastProviderIdentity,
  SameRawProvider,
} from "../broadcast/same-raw-broadcaster.js";
import type { Address, Hex32 } from "../core/canonical.js";
import { hexToBigInt, quantityToHex } from "../rpc/hex.js";
import { verifyRobinhoodMainnet, verifyRobinhoodSequencerWriteEndpoint } from "../rpc/robinhood.js";
import { JsonRpcRequestError, type Hex, type JsonRpcRequester } from "../rpc/types.js";

interface RpcBlock {
  readonly hash?: unknown;
}

interface RpcReceiptLog {
  readonly address?: unknown;
  readonly topics?: unknown;
  readonly data?: unknown;
  readonly logIndex?: unknown;
  readonly removed?: unknown;
}

interface RawRpcReceipt {
  readonly transactionHash?: unknown;
  readonly blockNumber?: unknown;
  readonly blockHash?: unknown;
  readonly transactionIndex?: unknown;
  readonly status?: unknown;
  readonly gasUsed?: unknown;
  readonly effectiveGasPrice?: unknown;
  readonly logs?: unknown;
}

export interface ProductionReceipt {
  readonly transactionHash: Hex32;
  readonly blockNumber: bigint;
  readonly blockHash: Hex32;
  readonly transactionIndex: bigint;
  readonly status: 0 | 1;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly logs: readonly Readonly<{
    address: Address;
    topics: readonly Hex[];
    data: Hex;
    logIndex: bigint;
    removed: boolean;
  }>[];
}

function requiredHex32(value: unknown, label: string): Hex32 {
  if (typeof value !== "string" || !isHexString(value, 32)) {
    throw new TypeError(`${label} must be a 32-byte hex value`);
  }
  return value as Hex32;
}

function requiredQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string") throw new TypeError(`${label} must be an RPC quantity`);
  return hexToBigInt(label, value);
}

export async function readGenesisHash(requester: JsonRpcRequester): Promise<Hex32> {
  const block = await requester.request<RpcBlock | null>("eth_getBlockByNumber", ["0x0", false]);
  if (block === null) throw new Error(`${requester.providerId} returned no genesis block`);
  return requiredHex32(block.hash, "genesis hash");
}

export class ProductionSameRawProvider implements SameRawProvider {
  readonly providerId: string;
  readonly region: string;
  readonly #requester: JsonRpcRequester;
  readonly #mode: "STANDARD" | "OFFICIAL_SEQUENCER";
  readonly #expectedGenesisHash: Hex32;

  constructor(input: {
    readonly requester: JsonRpcRequester;
    readonly region: string;
    readonly mode: "STANDARD" | "OFFICIAL_SEQUENCER";
    readonly expectedGenesisHash: Hex32;
  }) {
    this.providerId = input.requester.providerId;
    this.region = input.region;
    this.#requester = input.requester;
    this.#mode = input.mode;
    this.#expectedGenesisHash = input.expectedGenesisHash;
  }

  async probeIdentity(): Promise<BroadcastProviderIdentity> {
    if (this.#mode === "OFFICIAL_SEQUENCER") {
      await verifyRobinhoodSequencerWriteEndpoint(this.#requester);
    } else {
      await verifyRobinhoodMainnet(this.#requester);
      const observedGenesis = await readGenesisHash(this.#requester);
      if (observedGenesis.toLowerCase() !== this.#expectedGenesisHash.toLowerCase()) {
        throw new Error(`${this.providerId} returned the wrong genesis hash`);
      }
      try {
        await this.#requester.request("eth_sendRawTransaction", ["0x"]);
        throw new Error(`${this.providerId} unexpectedly accepted an empty transaction`);
      } catch (error) {
        if (error instanceof JsonRpcRequestError && error.code === -32_601) {
          throw new Error(`${this.providerId} has no sendRawTransaction method`);
        }
        if (!(error instanceof JsonRpcRequestError)) throw error;
      }
    }
    return Object.freeze({
      chainId: 4_663,
      genesisHash: this.#expectedGenesisHash,
      writeCapable: true,
      observedAt: new Date().toISOString(),
    });
  }

  async sendRawTransaction(rawTransaction: `0x${string}`): Promise<`0x${string}`> {
    if (!isHexString(rawTransaction) || rawTransaction === "0x") {
      throw new TypeError("signed transaction must be non-empty hex");
    }
    return this.#requester.request<`0x${string}`>("eth_sendRawTransaction", [rawTransaction]);
  }
}

export async function readProductionReceipt(
  requester: JsonRpcRequester,
  txHash: Hex32,
): Promise<ProductionReceipt | null> {
  const raw = await requester.request<RawRpcReceipt | null>("eth_getTransactionReceipt", [txHash]);
  if (raw === null) return null;
  const statusRaw = requiredQuantity(raw.status, "receipt.status");
  if (statusRaw !== 0n && statusRaw !== 1n) throw new Error("receipt status must be 0 or 1");
  if (!Array.isArray(raw.logs)) throw new TypeError("receipt.logs must be an array");
  const logs = raw.logs.map((value, index) => {
    if (value === null || typeof value !== "object") {
      throw new TypeError(`receipt.logs[${index}] must be an object`);
    }
    const log = value as RpcReceiptLog;
    if (typeof log.address !== "string") throw new TypeError("receipt log address is missing");
    if (!Array.isArray(log.topics) || log.topics.some((topic) => typeof topic !== "string")) {
      throw new TypeError("receipt log topics are invalid");
    }
    if (typeof log.data !== "string" || !isHexString(log.data)) {
      throw new TypeError("receipt log data is invalid");
    }
    return Object.freeze({
      address: getAddress(log.address) as Address,
      topics: Object.freeze(log.topics as Hex[]),
      data: log.data as Hex,
      logIndex: requiredQuantity(log.logIndex, "receipt.logIndex"),
      removed: log.removed === true,
    });
  });
  const transactionHash = requiredHex32(raw.transactionHash, "receipt.transactionHash");
  if (transactionHash.toLowerCase() !== txHash.toLowerCase()) {
    throw new Error("receipt transaction hash differs from the requested hash");
  }
  return Object.freeze({
    transactionHash,
    blockNumber: requiredQuantity(raw.blockNumber, "receipt.blockNumber"),
    blockHash: requiredHex32(raw.blockHash, "receipt.blockHash"),
    transactionIndex: requiredQuantity(raw.transactionIndex, "receipt.transactionIndex"),
    status: Number(statusRaw) as 0 | 1,
    gasUsed: requiredQuantity(raw.gasUsed, "receipt.gasUsed"),
    effectiveGasPrice: requiredQuantity(raw.effectiveGasPrice, "receipt.effectiveGasPrice"),
    logs: Object.freeze(logs),
  });
}

export async function readNativeBalance(
  requester: JsonRpcRequester,
  address: Address,
  block: bigint | "latest",
): Promise<bigint> {
  const value = await requester.request<string>("eth_getBalance", [
    address,
    block === "latest" ? "latest" : quantityToHex(block),
  ]);
  return requiredQuantity(value, "native balance");
}

const erc20 = new Interface(["function balanceOf(address account) view returns (uint256)"]);

export async function readTokenBalance(
  requester: JsonRpcRequester,
  token: Address,
  account: Address,
  block: bigint | "latest",
): Promise<bigint> {
  const value = await requester.request<string>("eth_call", [
    { to: token, data: erc20.encodeFunctionData("balanceOf", [account]) },
    block === "latest" ? "latest" : quantityToHex(block),
  ]);
  return BigInt(String(erc20.decodeFunctionResult("balanceOf", value)[0]));
}

const transferEvent = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]).getEvent("Transfer");
if (transferEvent === null) throw new Error("ERC20 Transfer ABI is unavailable");
const TRANSFER_TOPIC = transferEvent.topicHash;

export function sumTokenTransfersTo(
  receipt: ProductionReceipt,
  token: Address,
  beneficiary: Address,
): bigint {
  let total = 0n;
  for (const log of receipt.logs) {
    if (
      log.removed ||
      log.address.toLowerCase() !== token.toLowerCase() ||
      log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()
    ) {
      continue;
    }
    const parsed = new Interface([
      "event Transfer(address indexed from,address indexed to,uint256 value)",
    ]).parseLog({ topics: [...log.topics], data: log.data });
    if (
      parsed !== null &&
      getAddress(String(parsed.args.to)).toLowerCase() === beneficiary.toLowerCase()
    ) {
      total += BigInt(String(parsed.args.value));
    }
  }
  return total;
}

export class ProductionUnknownRecoveryProbe implements UnknownRecoveryProbe {
  readonly #requester: JsonRpcRequester;

  constructor(requester: JsonRpcRequester) {
    this.#requester = requester;
  }

  async snapshot(walletAddress: Address, txHash: Hex32): Promise<RecoveryProbeSnapshot> {
    const [receipt, transaction, latestNonce, pendingNonce, balance] = await Promise.all([
      readProductionReceipt(this.#requester, txHash),
      this.#requester.request<unknown | null>("eth_getTransactionByHash", [txHash]),
      this.#requester.request<string>("eth_getTransactionCount", [walletAddress, "latest"]),
      this.#requester.request<string>("eth_getTransactionCount", [walletAddress, "pending"]),
      this.#requester.request<string>("eth_getBalance", [walletAddress, "latest"]),
    ]);
    return Object.freeze({
      receipt:
        receipt === null
          ? null
          : Object.freeze({
              txHash: receipt.transactionHash,
              blockHash: receipt.blockHash,
              status: receipt.status,
            }),
      transactionKnown: transaction !== null,
      latestNonce: requiredQuantity(latestNonce, "latest nonce"),
      pendingNonce: requiredQuantity(pendingNonce, "pending nonce"),
      principalBalanceRaw: requiredQuantity(balance, "principal balance"),
      tokenBalanceRaw: 0n,
    });
  }
}
