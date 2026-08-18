import { createHash } from "node:crypto";

export type OfficialSiteLaunchStatus = "UNKNOWN" | "COMING_SOON" | "OPEN" | "PAUSED";
export type OfficialSiteScope = "GENERIC" | "LAUNCHER" | "CLOCKIN" | "SAFE_LAUNCH";

export interface OfficialSiteObservation {
  readonly rawHash: string;
  readonly semanticHash: string;
  readonly launchStatus: OfficialSiteLaunchStatus;
  readonly statusMarkers: readonly string[];
  readonly candidateAddresses: readonly `0x${string}`[];
  readonly clockInMentioned: boolean;
  readonly robinhoodChainMentioned: boolean;
}

export interface OfficialSiteObservationOptions {
  readonly scope?: OfficialSiteScope;
}

export interface OfficialSiteChange {
  readonly rawChanged: boolean;
  readonly semanticChanged: boolean;
  readonly statusChanged: boolean;
  readonly addressSetChanged: boolean;
  readonly addedAddresses: readonly `0x${string}`[];
  readonly removedAddresses: readonly `0x${string}`[];
}

const STATUS_PATTERNS = Object.freeze([
  Object.freeze({ marker: "COMING_SOON", pattern: /\bcoming\s+soon\b/iu }),
  Object.freeze({ marker: "SIGNAL_SCRAMBLED", pattern: /\bsignal\s+(?:is\s+)?scrambled\b/iu }),
  Object.freeze({ marker: "LAUNCH_NOW", pattern: /\blaunch\s+now\b/iu }),
  Object.freeze({
    marker: "STONK_LAUNCHER_OPEN",
    pattern: /\bstonk\s+launcher(?:\s+(?:is|now))?\s+(?:open|live(?:\s+now)?)\b/iu,
  }),
  Object.freeze({
    marker: "CLOCKIN_OPEN",
    pattern: /\bclock\s*in\s+(?:launch|sale)\s+(?:is\s+)?(?:open|live)\b/iu,
  }),
  Object.freeze({
    marker: "SAFE_LAUNCH_OPEN",
    pattern: /\bsafe\s+launch\s+(?:is\s+)?(?:open|live(?:\s+now)?)\b/iu,
  }),
  Object.freeze({
    marker: "SALE_OPEN",
    pattern: /\bsale\s+(?:is\s+)?(?:open|live)\b/iu,
  }),
  Object.freeze({ marker: "PAUSED", pattern: /\bpaused\b/iu }),
  Object.freeze({
    marker: "MAINTENANCE",
    pattern: /\b(?:under\s+maintenance|maintenance\s+mode)\b/iu,
  }),
]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function addAddress(target: Set<`0x${string}`>, value: string): void {
  target.add(value.toLowerCase() as `0x${string}`);
}

function extractAddresses(text: string, target: Set<`0x${string}`>): void {
  const pattern = /0x[0-9a-f]{40}/giu;
  for (const match of text.matchAll(pattern)) {
    const address = match[0];
    const index = match.index;
    const before = index === 0 ? "" : (text[index - 1] ?? "");
    const after = text[index + address.length] ?? "";
    if (/[0-9a-f]/iu.test(before) || /[0-9a-f]/iu.test(after)) continue;
    if (/^0x0{40}$/iu.test(address)) continue;
    addAddress(target, address);
  }
}

function candidateAddresses(html: string, visible: string): readonly `0x${string}`[] {
  const candidates = new Set<`0x${string}`>();
  extractAddresses(visible, candidates);

  const labelled =
    /(?:factory|token|contract|pool|ca)(?:[_\s-]*(?:address|addr))?["'\s:=,-]{0,48}(0x[0-9a-f]{40})/giu;
  for (const match of html.matchAll(labelled)) {
    const address = match[1];
    if (address !== undefined && !/^0x0{40}$/iu.test(address)) addAddress(candidates, address);
  }
  return Object.freeze([...candidates].sort());
}

function launchStatus(
  markers: readonly string[],
  scope: OfficialSiteScope,
): OfficialSiteLaunchStatus {
  if (markers.includes("PAUSED") || markers.includes("MAINTENANCE")) return "PAUSED";
  const open =
    markers.includes("LAUNCH_NOW") ||
    (scope === "LAUNCHER" && markers.includes("STONK_LAUNCHER_OPEN")) ||
    (scope === "CLOCKIN" && (markers.includes("CLOCKIN_OPEN") || markers.includes("SALE_OPEN"))) ||
    (scope === "SAFE_LAUNCH" && markers.includes("SAFE_LAUNCH_OPEN")) ||
    (scope === "GENERIC" &&
      markers.some((marker) =>
        ["STONK_LAUNCHER_OPEN", "CLOCKIN_OPEN", "SAFE_LAUNCH_OPEN", "SALE_OPEN"].includes(marker),
      ));
  if (open) {
    return "OPEN";
  }
  if (markers.includes("COMING_SOON") || markers.includes("SIGNAL_SCRAMBLED")) {
    return "COMING_SOON";
  }
  return "UNKNOWN";
}

/**
 * Whole-page bytes are retained for diagnostics, but action decisions use only
 * stable launch semantics. A framework chunk/hash change therefore cannot look
 * like a new contract or an opened launch.
 */
export function observeOfficialSite(
  html: string,
  options: OfficialSiteObservationOptions = {},
): OfficialSiteObservation {
  const visible = visibleText(html);
  const scope = options.scope ?? "GENERIC";
  const statusMarkers = Object.freeze(
    STATUS_PATTERNS.filter(({ pattern }) => pattern.test(visible)).map(({ marker }) => marker),
  );
  const addresses = candidateAddresses(html, visible);
  const status = launchStatus(statusMarkers, scope);
  const clockInMentioned = /\bclock\s*in\b/iu.test(visible);
  const robinhoodChainMentioned =
    /\brobinhood\s+chain\b/iu.test(visible) ||
    /(?:chain\s*id|chainId)["'\s:=,-]{0,16}4663\b/iu.test(html) ||
    /\beip155:4663\b/iu.test(html);
  const semanticPayload = JSON.stringify({
    candidateAddresses: addresses,
    clockInMentioned,
    launchStatus: status,
    robinhoodChainMentioned,
    statusMarkers,
  });
  return Object.freeze({
    rawHash: sha256(html),
    semanticHash: sha256(semanticPayload),
    launchStatus: status,
    statusMarkers,
    candidateAddresses: addresses,
    clockInMentioned,
    robinhoodChainMentioned,
  });
}

export function compareOfficialSiteObservations(
  previous: OfficialSiteObservation,
  current: OfficialSiteObservation,
): OfficialSiteChange {
  const previousAddresses = new Set(previous.candidateAddresses);
  const currentAddresses = new Set(current.candidateAddresses);
  const addedAddresses = Object.freeze(
    current.candidateAddresses.filter((address) => !previousAddresses.has(address)),
  );
  const removedAddresses = Object.freeze(
    previous.candidateAddresses.filter((address) => !currentAddresses.has(address)),
  );
  return Object.freeze({
    rawChanged: previous.rawHash !== current.rawHash,
    semanticChanged: previous.semanticHash !== current.semanticHash,
    statusChanged: previous.launchStatus !== current.launchStatus,
    addressSetChanged: addedAddresses.length > 0 || removedAddresses.length > 0,
    addedAddresses,
    removedAddresses,
  });
}
