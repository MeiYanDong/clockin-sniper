import type { SubmissionResult, TrancheIntent } from "./domain.js";
import type { TrancheSubmitter } from "./engine.js";
import { assertHex } from "./rpc/hex.js";
import { JsonRpcRequestError, type Hex, type JsonRpcRequester } from "./rpc/types.js";

export interface PreparedRawTransaction {
  readonly rawTransaction: Hex;
  readonly expectedTxHash?: Hex;
}

export interface PreparedTransactionSource {
  get(intent: TrancheIntent): Promise<PreparedRawTransaction>;
}

type ProviderOutcome =
  | { readonly kind: "success"; readonly state: "accepted" | "known"; readonly txHash?: Hex }
  | { readonly kind: "uncertain"; readonly error: Error }
  | { readonly kind: "rejected"; readonly error: Error };

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

function classifyError(error: unknown, expectedTxHash?: Hex): ProviderOutcome {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const message = messageOf(error);

  if (message.includes("already known") || message.includes("known transaction")) {
    return expectedTxHash === undefined
      ? { kind: "success", state: "known" }
      : { kind: "success", state: "known", txHash: expectedTxHash };
  }

  if (
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("connection") ||
    message.includes("http 429") ||
    /http 5\d\d/.test(message) ||
    message.includes("rate limit") ||
    message.includes("nonce too low") ||
    message.includes("replacement transaction underpriced")
  ) {
    return { kind: "uncertain", error: normalized };
  }

  return { kind: "rejected", error: normalized };
}

export class MultiRpcRawTransactionSubmitter implements TrancheSubmitter {
  readonly #requesters: readonly JsonRpcRequester[];
  readonly #source: PreparedTransactionSource;

  constructor(requesters: readonly JsonRpcRequester[], source: PreparedTransactionSource) {
    if (requesters.length === 0) {
      throw new RangeError("at least one broadcast RPC is required");
    }
    this.#requesters = Object.freeze([...requesters]);
    this.#source = source;
  }

  async submit(intent: TrancheIntent): Promise<SubmissionResult> {
    const prepared = await this.#source.get(intent);
    assertHex("rawTransaction", prepared.rawTransaction);
    if (prepared.expectedTxHash !== undefined) {
      assertHex("expectedTxHash", prepared.expectedTxHash);
    }

    const attemptId = `${intent.intentId}:attempt:${intent.attemptNumber}`;

    return new Promise<SubmissionResult>((resolve, reject) => {
      let remaining = this.#requesters.length;
      let settled = false;
      let sawUncertain = false;
      const rejectionErrors: Error[] = [];

      const finish = (): void => {
        remaining -= 1;
        if (remaining !== 0 || settled) return;
        settled = true;
        if (sawUncertain) {
          const result: SubmissionResult =
            prepared.expectedTxHash === undefined
              ? { state: "unknown", attemptId }
              : { state: "unknown", attemptId, txHash: prepared.expectedTxHash };
          resolve(Object.freeze(result));
          return;
        }
        reject(new AggregateError(rejectionErrors, `all RPCs rejected ${intent.intentId}`));
      };

      for (const requester of this.#requesters) {
        void this.#sendOne(requester, prepared).then((outcome) => {
          if (settled) return;

          if (outcome.kind === "success") {
            settled = true;
            const result: SubmissionResult =
              outcome.txHash === undefined
                ? { state: outcome.state, attemptId }
                : { state: outcome.state, attemptId, txHash: outcome.txHash };
            resolve(Object.freeze(result));
            return;
          }
          if (outcome.kind === "uncertain") {
            sawUncertain = true;
          } else {
            rejectionErrors.push(outcome.error);
          }
          finish();
        });
      }
    });
  }

  async #sendOne(
    requester: JsonRpcRequester,
    prepared: PreparedRawTransaction,
  ): Promise<ProviderOutcome> {
    try {
      const txHash = await requester.request<string>("eth_sendRawTransaction", [
        prepared.rawTransaction,
      ]);
      assertHex("eth_sendRawTransaction result", txHash);
      if (
        prepared.expectedTxHash !== undefined &&
        txHash.toLowerCase() !== prepared.expectedTxHash.toLowerCase()
      ) {
        return {
          kind: "rejected",
          error: new JsonRpcRequestError({
            providerId: requester.providerId,
            method: "eth_sendRawTransaction",
            message: "returned transaction hash does not match signed transaction",
          }),
        };
      }
      return { kind: "success", state: "accepted", txHash };
    } catch (error) {
      return classifyError(error, prepared.expectedTxHash);
    }
  }
}

export class InMemoryPreparedTransactionSource implements PreparedTransactionSource {
  readonly #transactions: ReadonlyMap<string, PreparedRawTransaction>;

  constructor(entries: Iterable<readonly [string, PreparedRawTransaction]>) {
    this.#transactions = new Map(entries);
  }

  async get(intent: TrancheIntent): Promise<PreparedRawTransaction> {
    const prepared = this.#transactions.get(intent.intentId);
    if (prepared === undefined) {
      throw new Error(`no prepared raw transaction for ${intent.intentId}`);
    }
    return prepared;
  }
}
