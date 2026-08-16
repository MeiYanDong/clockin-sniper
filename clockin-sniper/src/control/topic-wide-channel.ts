import { getAddress, keccak256 } from "ethers";

import { stableHash, type FactoryCandidate, type Knowledge } from "../core/canonical.js";
import { assertHex } from "../rpc/hex.js";
import type { Hex, JsonRpcRequester } from "../rpc/types.js";

export const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
export const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as Hex;
export const EIP1967_BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as Hex;

function codeHash(code: string): Hex {
  assertHex("runtime code", code);
  if (code === "0x") throw new Error("candidate runtime code is empty");
  return keccak256(code) as Hex;
}

function storageAddress(
  value: string,
  observedAt: string,
  evidenceId: string,
): Knowledge<`0x${string}`> {
  assertHex("proxy storage value", value);
  if (value.length !== 66 || /^0x0+$/.test(value)) {
    return Object.freeze({
      state: "UNKNOWN",
      reason: "proxy slot empty",
      since: observedAt,
      lastCheckedAt: observedAt,
    });
  }
  return Object.freeze({
    state: "KNOWN",
    value: getAddress(`0x${value.slice(-40)}`) as `0x${string}`,
    observedAt,
    evidenceIds: [evidenceId],
  });
}

export interface TopicWideFingerprintInput {
  readonly strategyId: string;
  readonly emitter: Hex;
  readonly blockNumber: bigint;
  readonly observedAt: string;
  readonly evidenceId: string;
}

export async function fingerprintTopicEmitter(
  requester: JsonRpcRequester,
  input: TopicWideFingerprintInput,
): Promise<FactoryCandidate> {
  const blockTag = `0x${input.blockNumber.toString(16)}` as Hex;
  const [runtime, implementationSlot, adminSlot, beaconSlot] = await Promise.all([
    requester.request<string>("eth_getCode", [input.emitter, blockTag]),
    requester.request<string>("eth_getStorageAt", [
      input.emitter,
      EIP1967_IMPLEMENTATION_SLOT,
      blockTag,
    ]),
    requester.request<string>("eth_getStorageAt", [input.emitter, EIP1967_ADMIN_SLOT, blockTag]),
    requester.request<string>("eth_getStorageAt", [input.emitter, EIP1967_BEACON_SLOT, blockTag]),
  ]);
  const runtimeCodeHash = codeHash(runtime);
  const implementationAddress = storageAddress(
    implementationSlot,
    input.observedAt,
    input.evidenceId,
  );
  const adminAddress = storageAddress(adminSlot, input.observedAt, input.evidenceId);
  const beaconAddress = storageAddress(beaconSlot, input.observedAt, input.evidenceId);
  let implementationCodeHash: FactoryCandidate["implementationCodeHash"] = Object.freeze({
    state: "UNSUPPORTED",
    reason: "candidate is not an EIP-1967 proxy",
  });
  if (implementationAddress.state === "KNOWN") {
    const implementationCode = await requester.request<string>("eth_getCode", [
      implementationAddress.value,
      blockTag,
    ]);
    implementationCodeHash = Object.freeze({
      state: "KNOWN",
      value: codeHash(implementationCode),
      observedAt: input.observedAt,
      evidenceIds: [input.evidenceId],
    });
  }
  return Object.freeze({
    candidateId: `factory-candidate:${stableHash({ emitter: input.emitter, blockTag })}`,
    strategyId: input.strategyId,
    revision: 1,
    chainId: 4663,
    address: getAddress(input.emitter) as `0x${string}`,
    observedBlock: input.blockNumber.toString(),
    runtimeCodeHash: Object.freeze({
      state: "KNOWN",
      value: runtimeCodeHash,
      observedAt: input.observedAt,
      evidenceIds: [input.evidenceId],
    }),
    implementationAddress,
    implementationCodeHash,
    proxyType:
      beaconAddress.state === "KNOWN"
        ? Object.freeze({
            state: "KNOWN" as const,
            value: "BEACON" as const,
            observedAt: input.observedAt,
            evidenceIds: [input.evidenceId],
          })
        : implementationAddress.state === "KNOWN"
          ? Object.freeze({
              state: "KNOWN" as const,
              value: "EIP1967" as const,
              observedAt: input.observedAt,
              evidenceIds: [input.evidenceId],
            })
          : Object.freeze({
              state: "KNOWN" as const,
              value: "NONE" as const,
              observedAt: input.observedAt,
              evidenceIds: [input.evidenceId],
            }),
    adminAddress,
    beaconAddress,
    evidenceIds: [input.evidenceId],
    createdAt: input.observedAt,
  });
}

export function matchFactoryFamily(
  candidate: FactoryCandidate,
  allowedRuntimeHashes: ReadonlySet<string>,
  allowedImplementationHashes: ReadonlySet<string>,
): "PROFILE_MATCHED" | "FINGERPRINTED" {
  const runtimeMatched =
    candidate.runtimeCodeHash.state === "KNOWN" &&
    allowedRuntimeHashes.has(candidate.runtimeCodeHash.value.toLowerCase());
  const implementationMatched =
    candidate.implementationCodeHash.state === "KNOWN" &&
    allowedImplementationHashes.has(candidate.implementationCodeHash.value.toLowerCase());
  return runtimeMatched || implementationMatched ? "PROFILE_MATCHED" : "FINGERPRINTED";
}

export interface ProxyIdentityChange {
  readonly field:
    | "implementationAddress"
    | "implementationCodeHash"
    | "adminAddress"
    | "beaconAddress";
  readonly previousHash: string;
  readonly currentHash: string;
}

export function diffProxyIdentity(
  previous: FactoryCandidate,
  current: FactoryCandidate,
): readonly ProxyIdentityChange[] {
  if (previous.address.toLowerCase() !== current.address.toLowerCase()) {
    throw new Error("cannot diff proxy identity for different emitters");
  }
  const fields = [
    "implementationAddress",
    "implementationCodeHash",
    "adminAddress",
    "beaconAddress",
  ] as const;
  return Object.freeze(
    fields.flatMap((field) => {
      const previousHash = stableHash(previous[field]);
      const currentHash = stableHash(current[field]);
      return previousHash === currentHash
        ? []
        : [Object.freeze({ field, previousHash, currentHash })];
    }),
  );
}
