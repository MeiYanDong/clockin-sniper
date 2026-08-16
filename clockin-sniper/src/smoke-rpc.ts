import { HttpJsonRpcClient } from "./rpc/http-json-rpc.js";
import { hexToBigInt } from "./rpc/hex.js";
import { ROBINHOOD_PUBLIC_RPC_URL, verifyRobinhoodMainnet } from "./rpc/robinhood.js";

const rpcUrl = process.env.ROBINHOOD_RPC_URL ?? ROBINHOOD_PUBLIC_RPC_URL;
const client = new HttpJsonRpcClient({
  providerId: process.env.ROBINHOOD_RPC_PROVIDER_ID ?? "robinhood-rpc-smoke",
  url: rpcUrl,
  timeoutMs: 5_000,
});

const identity = await verifyRobinhoodMainnet(client);
const latestBlock = await client.request<{ readonly baseFeePerGas?: string }>(
  "eth_getBlockByNumber",
  ["latest", false],
);
if (latestBlock.baseFeePerGas === undefined) {
  throw new Error("Robinhood RPC latest block has no baseFeePerGas");
}
const baseFeePerGasWei = hexToBigInt("baseFeePerGas", latestBlock.baseFeePerGas);
process.stdout.write(
  `${JSON.stringify({
    providerId: identity.providerId,
    chainId: identity.chainId.toString(),
    blockNumber: identity.blockNumber.toString(),
    baseFeePerGasWei: baseFeePerGasWei.toString(),
    eip1559: true,
    verifiedAt: new Date().toISOString(),
  })}\n`,
);
