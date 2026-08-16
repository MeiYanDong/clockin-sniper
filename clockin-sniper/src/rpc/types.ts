export type Hex = `0x${string}`;

export interface JsonRpcRequester {
  readonly providerId: string;
  request<T>(method: string, params?: readonly unknown[]): Promise<T>;
}

export interface JsonRpcErrorShape {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export class JsonRpcRequestError extends Error {
  readonly providerId: string;
  readonly method: string;
  readonly code: number | null;
  readonly rpcData: unknown;

  constructor(options: {
    providerId: string;
    method: string;
    message: string;
    code?: number;
    rpcData?: unknown;
    cause?: unknown;
  }) {
    super(`${options.providerId} ${options.method}: ${options.message}`, {
      cause: options.cause,
    });
    this.name = "JsonRpcRequestError";
    this.providerId = options.providerId;
    this.method = options.method;
    this.code = options.code ?? null;
    this.rpcData = options.rpcData;
  }
}
