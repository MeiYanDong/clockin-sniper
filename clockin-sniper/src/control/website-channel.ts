import { getAddress, isHexString, keccak256 } from "ethers";

import { CanonicalInvariantError, stableHash } from "../core/canonical.js";

export interface WebsiteResponse {
  readonly status: number;
  readonly body: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly contentType?: string;
}

export type WebsiteFetcher = (url: string) => Promise<WebsiteResponse>;

export interface WebsiteAddressRule {
  readonly url: string;
  readonly format: "json" | "html_data_attribute" | "js_runtime_config";
  readonly path: string;
  readonly runtimeObjectMarker?: string;
  readonly chainIdPath?: string;
  readonly expectedChainId: number;
  readonly field: "factory" | "token" | "pool";
}

export interface WebsiteAddressEvidence {
  readonly evidenceId: string;
  readonly url: string;
  readonly field: WebsiteAddressRule["field"];
  readonly address: `0x${string}`;
  readonly chainId: number;
  readonly parserPath: string;
  readonly contentHash: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly observedAt: string;
}

export type WebsitePollResult =
  | Readonly<{ state: "EVIDENCE"; evidence: WebsiteAddressEvidence }>
  | Readonly<{ state: "ERROR"; url: string; reason: string; observedAt: string }>;

export interface VerifiedWebsiteTokenEvidence extends WebsiteAddressEvidence {
  readonly tokenRuntimeCodeHash: `0x${string}`;
  readonly factoryProfileState: "VERIFIED" | "HOT_ARMED";
}

export function verifyWebsiteTokenEvidence(input: {
  readonly evidence: WebsiteAddressEvidence;
  readonly tokenRuntimeCode: `0x${string}`;
  readonly allowedTokenRuntimeHashes: ReadonlySet<string>;
  readonly factoryProfileState: string;
}): VerifiedWebsiteTokenEvidence {
  if (input.evidence.field !== "token") {
    throw new CanonicalInvariantError("IDENTITY_INCOMPLETE", "website evidence is not a token CA");
  }
  if (input.factoryProfileState !== "VERIFIED" && input.factoryProfileState !== "HOT_ARMED") {
    throw new CanonicalInvariantError(
      "IDENTITY_INCOMPLETE",
      "website CA is not bound to a verified Factory profile",
    );
  }
  if (!isHexString(input.tokenRuntimeCode) || input.tokenRuntimeCode === "0x") {
    throw new CanonicalInvariantError(
      "IDENTITY_INCOMPLETE",
      "website token CA has no runtime code",
    );
  }
  const tokenRuntimeCodeHash = keccak256(input.tokenRuntimeCode) as `0x${string}`;
  if (!input.allowedTokenRuntimeHashes.has(tokenRuntimeCodeHash.toLowerCase())) {
    throw new CanonicalInvariantError(
      "IDENTITY_INCOMPLETE",
      "website token runtime is not in the verified Factory family",
    );
  }
  return Object.freeze({
    ...input.evidence,
    tokenRuntimeCodeHash,
    factoryProfileState: input.factoryProfileState,
  });
}

function jsonPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function htmlAttribute(body: string, attribute: string): string | undefined {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}=["']([^"']+)["']`, "i").exec(body);
  return match?.[1];
}

function runtimeJson(body: string, marker: string): unknown {
  const markerIndex = body.indexOf(marker);
  if (markerIndex < 0) throw new Error(`runtime marker ${marker} is missing`);
  const start = body.indexOf("{", markerIndex + marker.length);
  if (start < 0) throw new Error(`runtime marker ${marker} has no JSON object`);
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = start; index < body.length; index += 1) {
    const character = body[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(body.slice(start, index + 1)) as unknown;
    }
  }
  throw new Error(`runtime marker ${marker} has an unterminated JSON object`);
}

export class WebsiteChannel {
  readonly #allowed = new Set<string>();
  readonly #fetcher: WebsiteFetcher;
  readonly #history = new Map<string, readonly WebsiteAddressEvidence[]>();

  constructor(allowedUrls: readonly string[], fetcher: WebsiteFetcher) {
    for (const url of allowedUrls) this.#allowed.add(new URL(url).toString());
    this.#fetcher = fetcher;
  }

  async poll(rule: WebsiteAddressRule, observedAt: string): Promise<WebsiteAddressEvidence> {
    const canonicalUrl = new URL(rule.url).toString();
    if (!this.#allowed.has(canonicalUrl)) throw new Error("website URL is not allowlisted");
    const response = await this.#fetcher(canonicalUrl);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`website returned HTTP ${response.status}`);
    }
    let addressValue: unknown;
    let chainIdValue: unknown = rule.expectedChainId;
    if (rule.format === "json") {
      const parsed = JSON.parse(response.body) as unknown;
      addressValue = jsonPath(parsed, rule.path);
      if (rule.chainIdPath !== undefined) chainIdValue = jsonPath(parsed, rule.chainIdPath);
    } else if (rule.format === "html_data_attribute") {
      addressValue = htmlAttribute(response.body, rule.path);
      if (rule.chainIdPath !== undefined)
        chainIdValue = htmlAttribute(response.body, rule.chainIdPath);
    } else {
      const parsed = runtimeJson(
        response.body,
        rule.runtimeObjectMarker ?? "window.__RUNTIME_CONFIG__",
      );
      addressValue = jsonPath(parsed, rule.path);
      if (rule.chainIdPath !== undefined) chainIdValue = jsonPath(parsed, rule.chainIdPath);
    }
    if (Number(chainIdValue) !== rule.expectedChainId) {
      throw new Error(
        `website chainId ${String(chainIdValue)} does not match ${rule.expectedChainId}`,
      );
    }
    if (typeof addressValue !== "string") throw new Error(`website path ${rule.path} is missing`);
    const contentHash = stableHash(response.body);
    const evidence = Object.freeze({
      evidenceId: `website:${stableHash({ canonicalUrl, contentHash, path: rule.path })}`,
      url: canonicalUrl,
      field: rule.field,
      address: getAddress(addressValue) as `0x${string}`,
      chainId: rule.expectedChainId,
      parserPath: rule.path,
      contentHash,
      ...(response.etag === undefined ? {} : { etag: response.etag }),
      ...(response.lastModified === undefined ? {} : { lastModified: response.lastModified }),
      observedAt,
    });
    const historyKey = `${canonicalUrl}\u0000${rule.field}`;
    const history = this.#history.get(historyKey) ?? [];
    if (!history.some((item) => item.evidenceId === evidence.evidenceId)) {
      this.#history.set(historyKey, Object.freeze([...history, evidence]));
    }
    return evidence;
  }

  async pollSafe(rule: WebsiteAddressRule, observedAt: string): Promise<WebsitePollResult> {
    try {
      return Object.freeze({ state: "EVIDENCE", evidence: await this.poll(rule, observedAt) });
    } catch (error) {
      return Object.freeze({
        state: "ERROR",
        url: new URL(rule.url).toString(),
        reason: error instanceof Error ? error.message : String(error),
        observedAt,
      });
    }
  }

  history(url: string, field: WebsiteAddressRule["field"]): readonly WebsiteAddressEvidence[] {
    return this.#history.get(`${new URL(url).toString()}\u0000${field}`) ?? Object.freeze([]);
  }
}
