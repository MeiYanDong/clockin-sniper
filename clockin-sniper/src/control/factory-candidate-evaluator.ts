import { keccak256 } from "ethers";

import { stableHash, type FactoryCandidate } from "../core/canonical.js";
import { assertHex } from "../rpc/hex.js";
import type { Hex, JsonRpcRequester } from "../rpc/types.js";
import {
  fingerprintTopicEmitter,
  matchFactoryFamily,
  type TopicWideFingerprintInput,
} from "./topic-wide-channel.js";

export interface TopicLaunchBinding extends TopicWideFingerprintInput {
  readonly tokenAddress: Hex;
  readonly poolAddress: Hex;
}

export interface FactoryFamilyPolicy {
  readonly policyId: string;
  readonly revision: number;
  readonly allowedFactoryRuntimeHashes: ReadonlySet<string>;
  readonly allowedImplementationHashes: ReadonlySet<string>;
  readonly allowedTokenRuntimeHashes: ReadonlySet<string>;
  readonly allowedPoolRuntimeHashes: ReadonlySet<string>;
}

export interface TopicEmitterEvaluation {
  readonly evaluationId: string;
  readonly candidate: FactoryCandidate;
  readonly state: "FINGERPRINTED" | "PROFILE_MATCHED" | "VERIFIED";
  readonly tokenRuntimeCodeHash: Hex;
  readonly poolRuntimeCodeHash: Hex;
  readonly fundsAuthorized: false;
  readonly reasons: readonly string[];
  readonly evaluatedAt: string;
}

function hashRuntime(name: string, code: string): Hex {
  assertHex(name, code);
  if (code === "0x") throw new Error(`${name} is empty`);
  return keccak256(code) as Hex;
}

export async function evaluateTopicEmitterAtExactBlock(
  requester: JsonRpcRequester,
  binding: TopicLaunchBinding,
  policy: FactoryFamilyPolicy,
): Promise<TopicEmitterEvaluation> {
  const candidate = await fingerprintTopicEmitter(requester, binding);
  const blockTag = `0x${binding.blockNumber.toString(16)}` as Hex;
  const [tokenCode, poolCode] = await Promise.all([
    requester.request<string>("eth_getCode", [binding.tokenAddress, blockTag]),
    requester.request<string>("eth_getCode", [binding.poolAddress, blockTag]),
  ]);
  const tokenRuntimeCodeHash = hashRuntime("token runtime code", tokenCode);
  const poolRuntimeCodeHash = hashRuntime("pool runtime code", poolCode);
  const familyState = matchFactoryFamily(
    candidate,
    policy.allowedFactoryRuntimeHashes,
    policy.allowedImplementationHashes,
  );
  const reasons: string[] = [];
  if (familyState !== "PROFILE_MATCHED") reasons.push("FACTORY_FAMILY_UNKNOWN");
  if (!policy.allowedTokenRuntimeHashes.has(tokenRuntimeCodeHash.toLowerCase())) {
    reasons.push("TOKEN_CODE_UNKNOWN");
  }
  if (!policy.allowedPoolRuntimeHashes.has(poolRuntimeCodeHash.toLowerCase())) {
    reasons.push("POOL_CODE_UNKNOWN");
  }
  const state =
    reasons.length === 0
      ? "VERIFIED"
      : familyState === "PROFILE_MATCHED"
        ? "PROFILE_MATCHED"
        : "FINGERPRINTED";
  return Object.freeze({
    evaluationId: `factory-evaluation:${stableHash({
      policyId: policy.policyId,
      revision: policy.revision,
      candidateId: candidate.candidateId,
      tokenRuntimeCodeHash,
      poolRuntimeCodeHash,
    })}`,
    candidate,
    state,
    tokenRuntimeCodeHash,
    poolRuntimeCodeHash,
    fundsAuthorized: false,
    reasons: Object.freeze(reasons),
    evaluatedAt: binding.observedAt,
  });
}
