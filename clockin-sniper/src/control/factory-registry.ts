import {
  CanonicalInvariantError,
  stableHash,
  type FactoryProfile,
  type FactoryProfileState,
} from "../core/canonical.js";
import { assertTransition, factoryProfileTransitions } from "../core/state-machine.js";

export type FactoryProfileDraft = Omit<FactoryProfile, "configHash">;

export interface FactoryProfileFieldDiff {
  readonly field: string;
  readonly previousHash: string;
  readonly currentHash: string;
}

const profileIdentityFields = [
  "address",
  "runtimeCodeHash",
  "proxyType",
  "implementationAddress",
  "implementationCodeHash",
  "adminAddress",
  "launchEventTopic",
  "eventAbiHash",
  "adapterIds",
  "quoteAssets",
  "lifecycle",
  "state",
] as const satisfies ReadonlyArray<keyof FactoryProfile>;

export function diffFactoryProfiles(
  previous: FactoryProfile,
  current: FactoryProfile,
): readonly FactoryProfileFieldDiff[] {
  if (previous.profileId !== current.profileId) throw new Error("cannot diff unrelated profiles");
  return Object.freeze(
    profileIdentityFields.flatMap((field) => {
      const previousHash = stableHash(previous[field]);
      const currentHash = stableHash(current[field]);
      return previousHash === currentHash
        ? []
        : [Object.freeze({ field, previousHash, currentHash })];
    }),
  );
}

export class FactoryRegistry {
  readonly #profiles = new Map<string, readonly FactoryProfile[]>();

  register(draft: FactoryProfileDraft): FactoryProfile {
    const revisions = this.#profiles.get(draft.profileId) ?? [];
    const previous = revisions.at(-1);
    if (previous !== undefined && draft.revision !== previous.revision + 1) {
      throw new RangeError(`profile revision must advance from ${previous.revision}`);
    }
    if (previous === undefined && draft.revision !== 1) {
      throw new RangeError("first profile revision must be 1");
    }
    const configHash = stableHash({ ...draft, configHash: undefined });
    const profile = Object.freeze({ ...draft, configHash });
    this.#profiles.set(draft.profileId, Object.freeze([...revisions, profile]));
    return profile;
  }

  transition(
    profileId: string,
    to: FactoryProfileState,
    evidenceIds: readonly string[],
    lastVerifiedBlock: string,
    createdAt: string,
  ): FactoryProfile {
    const current = this.current(profileId);
    assertTransition(factoryProfileTransitions, current.state, to);
    return this.register({
      ...current,
      revision: current.revision + 1,
      state: to,
      evidenceIds: Object.freeze([...current.evidenceIds, ...evidenceIds]),
      lastVerifiedBlock,
      createdAt,
    });
  }

  current(profileId: string): FactoryProfile {
    const current = this.#profiles.get(profileId)?.at(-1);
    if (current === undefined) throw new Error(`factory profile ${profileId} is unknown`);
    return current;
  }

  byAddress(address: string): readonly FactoryProfile[] {
    return Object.freeze(
      [...this.#profiles.values()]
        .map((revisions) => revisions.at(-1))
        .filter((profile): profile is FactoryProfile => profile !== undefined)
        .filter((profile) => profile.address.toLowerCase() === address.toLowerCase()),
    );
  }

  assertExecutionReady(
    profileId: string,
    revision: number,
    actualRuntimeCodeHash: string,
    actualImplementationCodeHash?: string,
  ): FactoryProfile {
    const profile = this.current(profileId);
    if (profile.revision !== revision) {
      throw new CanonicalInvariantError(
        "FACTORY_CODE_DRIFT",
        `profile ${profileId} revision ${revision} is stale; current is ${profile.revision}`,
      );
    }
    if (profile.state !== "HOT_ARMED") {
      throw new CanonicalInvariantError(
        "IDENTITY_INCOMPLETE",
        `profile ${profileId} is ${profile.state}, not HOT_ARMED`,
      );
    }
    if (profile.runtimeCodeHash.toLowerCase() !== actualRuntimeCodeHash.toLowerCase()) {
      throw new CanonicalInvariantError("FACTORY_CODE_DRIFT", "factory runtime code hash drifted");
    }
    if (
      profile.implementationCodeHash.state === "KNOWN" &&
      (actualImplementationCodeHash === undefined ||
        profile.implementationCodeHash.value.toLowerCase() !==
          actualImplementationCodeHash.toLowerCase())
    ) {
      throw new CanonicalInvariantError(
        "FACTORY_CODE_DRIFT",
        "factory implementation code hash drifted",
      );
    }
    return profile;
  }

  observeCodeIdentity(input: {
    profileId: string;
    actualRuntimeCodeHash: string;
    actualImplementationCodeHash?: string;
    evidenceId: string;
    blockNumber: string;
    observedAt: string;
  }): FactoryProfile {
    const current = this.current(input.profileId);
    const runtimeDrift =
      current.runtimeCodeHash.toLowerCase() !== input.actualRuntimeCodeHash.toLowerCase();
    const implementationDrift =
      current.implementationCodeHash.state === "KNOWN" &&
      (input.actualImplementationCodeHash === undefined ||
        current.implementationCodeHash.value.toLowerCase() !==
          input.actualImplementationCodeHash.toLowerCase());
    if (!runtimeDrift && !implementationDrift) return current;
    if (current.state === "VERIFIED" || current.state === "HOT_ARMED") {
      return this.transition(
        input.profileId,
        "STALE_REVERIFY_REQUIRED",
        [input.evidenceId],
        input.blockNumber,
        input.observedAt,
      );
    }
    if (current.state === "STALE_REVERIFY_REQUIRED") return current;
    return this.transition(
      input.profileId,
      "QUARANTINED",
      [input.evidenceId],
      input.blockNumber,
      input.observedAt,
    );
  }
}
