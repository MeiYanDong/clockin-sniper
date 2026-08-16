export type AlertKind =
  | "FACTORY_CANDIDATE"
  | "PROFILE_DRIFT"
  | "IDENTITY_FROZEN"
  | "CA_CONFIRMED"
  | "CA_MISMATCH"
  | "LANE_BROADCAST"
  | "LANE_RECEIPT"
  | "LANE_EFFECT"
  | "UNKNOWN_ATTEMPT"
  | "REVERTED"
  | "SUCCESS_NO_TOKENS"
  | "RPC_WSS_LAG"
  | "FUNDING_SHORTFALL"
  | "FINALIZE_LIQUIDITY"
  | "PRINCIPAL_RECOVERY"
  | "EXIT_EFFECT"
  | "NO_EXECUTABLE_EXIT_ROUTE";

export interface AlertEvent {
  readonly kind: AlertKind;
  readonly severity: "INFO" | "WARNING" | "CRITICAL";
  readonly strategyId: string;
  readonly launchId?: string;
  readonly objectId: string;
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
}

export interface AlertTransport {
  readonly transportId: string;
  send(event: AlertEvent): Promise<void>;
}

const SENSITIVE_KEYS = new Set([
  "privatekey",
  "private_key",
  "rawtransaction",
  "raw_transaction",
  "rpcurl",
  "rpc_url",
  "wsrpcurl",
  "ws_rpc_url",
  "credential",
  "credentials",
  "secret",
  "authtoken",
  "auth_token",
  "vaultkey",
  "vault_key",
]);

function redact(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEYS.has(key.toLowerCase())) return "[REDACTED]";
  if (typeof value === "string" && /^(?:https?|wss?):\/\//iu.test(value)) return "[REDACTED_URL]";
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redact(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

export function redactAlert(event: AlertEvent): AlertEvent {
  return Object.freeze({
    ...event,
    message: redact(event.message) as string,
    fields: Object.freeze(redact(event.fields) as Record<string, unknown>),
  });
}

export class AsyncAlertDispatcher {
  readonly #transports: readonly AlertTransport[];
  readonly #pending = new Set<Promise<void>>();
  readonly failures: { readonly transportId: string; readonly message: string }[] = [];

  constructor(transports: readonly AlertTransport[]) {
    this.#transports = Object.freeze([...transports]);
  }

  publish(event: AlertEvent): void {
    const safe = redactAlert(event);
    for (const transport of this.#transports) {
      const pending = Promise.resolve()
        .then(() => transport.send(safe))
        .catch((error: unknown) => {
          this.failures.push(
            Object.freeze({
              transportId: transport.transportId,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        })
        .finally(() => this.#pending.delete(pending));
      this.#pending.add(pending);
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...this.#pending]);
  }
}
