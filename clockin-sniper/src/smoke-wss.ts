import {
  WebSocketNewHeadsClient,
  type NewHead,
  type NewHeadsSubscription,
} from "./rpc/websocket-new-heads.js";

const wsUrl = process.env.ROBINHOOD_WS_RPC_URL?.trim();
if (wsUrl === undefined || wsUrl.length === 0) {
  throw new Error("ROBINHOOD_WS_RPC_URL is required");
}

const providerId = process.env.ROBINHOOD_RPC_PROVIDER_ID ?? "robinhood-wss-smoke";
const client = new WebSocketNewHeadsClient({ providerId, url: wsUrl });
let resolveHead!: (head: NewHead) => void;
let rejectHead!: (error: Error) => void;
const headPromise = new Promise<NewHead>((resolve, reject) => {
  resolveHead = resolve;
  rejectHead = reject;
});

let subscription: NewHeadsSubscription | undefined;
try {
  subscription = await client.subscribe(resolveHead);
  const timeout = setTimeout(
    () => rejectHead(new Error(`${providerId} did not emit a new head in time`)),
    10_000,
  );
  const head = await headPromise.finally(() => clearTimeout(timeout));
  process.stdout.write(
    `${JSON.stringify({
      providerId,
      chainId: "4663",
      blockNumber: head.blockNumber.toString(),
      subscription: "newHeads",
      verifiedAt: new Date().toISOString(),
    })}\n`,
  );
} finally {
  subscription?.close();
  await subscription?.done.catch(() => undefined);
}
