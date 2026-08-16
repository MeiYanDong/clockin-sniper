import { HttpJsonRpcClient } from "./rpc/http-json-rpc.js";
import {
  ROBINHOOD_MAINNET_SEQUENCER_URL,
  verifyRobinhoodSequencerWriteEndpoint,
} from "./rpc/robinhood.js";

const requester = new HttpJsonRpcClient({
  providerId: "robinhood-direct-sequencer",
  url: ROBINHOOD_MAINNET_SEQUENCER_URL,
  timeoutMs: 2_000,
});

await verifyRobinhoodSequencerWriteEndpoint(requester);
process.stdout.write(
  `${JSON.stringify({
    providerId: requester.providerId,
    method: "eth_sendRawTransaction",
    probePayload: "invalid_empty_transaction",
    result: "deterministic_rejection_confirmed",
    signedTransactionSent: false,
    verifiedAt: new Date().toISOString(),
  })}\n`,
);
