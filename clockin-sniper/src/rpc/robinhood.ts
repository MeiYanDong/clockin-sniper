import { hexToBigInt } from "./hex.js";
import { JsonRpcRequestError, type JsonRpcRequester } from "./types.js";

export const ROBINHOOD_MAINNET_CHAIN_ID = 4_663n;
export const ROBINHOOD_PUBLIC_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
/**
 * Keyless public fallback used only by the always-on, non-signing Control plane.
 * The paid Chainstack endpoints remain isolated in systemd credentials and are
 * never loaded by Control.
 */
export const ROBINHOOD_KEYLESS_PUBLIC_RPC_FALLBACK_URL =
  "https://robinhood-mainnet-rpc.blockreq.com/v1/rpc/public";
export const ROBINHOOD_MAINNET_SEQUENCER_URL = "https://sequencer.mainnet.chain.robinhood.com";

export interface RobinhoodRpcIdentity {
  readonly providerId: string;
  readonly chainId: bigint;
  readonly blockNumber: bigint;
}

export async function verifyRobinhoodMainnet(
  requester: JsonRpcRequester,
): Promise<RobinhoodRpcIdentity> {
  const [chainIdHex, blockNumberHex] = await Promise.all([
    requester.request<string>("eth_chainId"),
    requester.request<string>("eth_blockNumber"),
  ]);
  const chainId = hexToBigInt("eth_chainId", chainIdHex);
  const blockNumber = hexToBigInt("eth_blockNumber", blockNumberHex);

  if (chainId !== ROBINHOOD_MAINNET_CHAIN_ID) {
    throw new Error(
      `${requester.providerId} is chain ${chainId}, expected Robinhood mainnet ${ROBINHOOD_MAINNET_CHAIN_ID}`,
    );
  }

  return Object.freeze({ providerId: requester.providerId, chainId, blockNumber });
}

/**
 * The official write-only Sequencer endpoint does not expose eth_chainId. Probe
 * its send method with an invalid empty payload and require the deterministic
 * parse rejection observed on the official endpoint. No signed transaction is
 * created or submitted by this check.
 */
export async function verifyRobinhoodSequencerWriteEndpoint(
  requester: JsonRpcRequester,
): Promise<void> {
  try {
    await requester.request("eth_sendRawTransaction", ["0x"]);
  } catch (error) {
    if (
      error instanceof JsonRpcRequestError &&
      error.code === -32_000 &&
      /typed transaction too short/i.test(error.message)
    ) {
      return;
    }
    throw new Error(`${requester.providerId} failed the Robinhood Sequencer write probe`, {
      cause: error,
    });
  }
  throw new Error(`${requester.providerId} unexpectedly accepted an empty transaction`);
}
