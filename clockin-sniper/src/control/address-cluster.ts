import { getAddress } from "ethers";

export type RelationshipType =
  | "DEPLOYED_BY"
  | "CALLED_BY"
  | "OWNED_BY"
  | "ADMINISTERED_BY"
  | "FUNDED_BY";

export interface AddressGraphEdge {
  readonly from: `0x${string}`;
  readonly to: `0x${string}`;
  readonly relationshipType: RelationshipType;
  readonly sourceTxHash: `0x${string}`;
  readonly observedBlock: bigint;
  readonly reviewState: "PENDING" | "APPROVED" | "REJECTED";
}

export interface AddressClusterConfig {
  readonly clusterId: string;
  readonly revision: number;
  readonly rootAddresses: readonly `0x${string}`[];
  readonly evidenceIds: readonly string[];
  readonly approvedAt: string;
}

export interface DeploymentReceiptObservation {
  readonly transactionHash: `0x${string}`;
  readonly from: `0x${string}`;
  readonly to: `0x${string}` | null;
  readonly contractAddress: `0x${string}` | null;
  readonly blockNumber: bigint;
  readonly status: "SUCCESS" | "REVERTED";
}

export interface AdminTransactionObservation {
  readonly transactionHash: `0x${string}`;
  readonly from: `0x${string}`;
  readonly to: `0x${string}` | null;
  readonly blockNumber: bigint;
  readonly status: "SUCCESS" | "REVERTED";
  readonly relationshipType: "CALLED_BY" | "OWNED_BY" | "ADMINISTERED_BY";
}

export interface AddressCandidateAlert {
  readonly alertId: string;
  readonly clusterId: string;
  readonly clusterRevision: number;
  readonly candidateAddress: `0x${string}`;
  readonly reason: "ROOT_CONTRACT_DEPLOYMENT" | "APPROVED_ADMIN_CHANGE";
  readonly sourceTxHash: `0x${string}`;
  readonly sourceBlock: bigint;
  readonly reviewState: "PENDING";
}

function isClusterConfig(
  value: readonly string[] | AddressClusterConfig,
): value is AddressClusterConfig {
  return !Array.isArray(value) && "clusterId" in value;
}

export class AddressCluster {
  readonly config: AddressClusterConfig;
  readonly #roots: ReadonlySet<string>;
  readonly #edges = new Map<string, AddressGraphEdge>();

  constructor(rootAddresses: readonly string[] | AddressClusterConfig) {
    this.config = !isClusterConfig(rootAddresses)
      ? Object.freeze({
          clusterId: "legacy-cluster",
          revision: 1,
          rootAddresses: Object.freeze(
            rootAddresses.map((address) => getAddress(address) as `0x${string}`),
          ),
          evidenceIds: Object.freeze([]),
          approvedAt: "1970-01-01T00:00:00.000Z",
        })
      : Object.freeze({
          ...rootAddresses,
          rootAddresses: Object.freeze(
            rootAddresses.rootAddresses.map((address) => getAddress(address) as `0x${string}`),
          ),
          evidenceIds: Object.freeze([...rootAddresses.evidenceIds]),
        });
    if (this.config.revision < 1 || !Number.isSafeInteger(this.config.revision)) {
      throw new RangeError("address cluster revision must be a positive integer");
    }
    this.#roots = new Set(
      this.config.rootAddresses.map((address) => getAddress(address).toLowerCase()),
    );
  }

  add(edge: AddressGraphEdge): boolean {
    const normalized = Object.freeze({
      ...edge,
      from: getAddress(edge.from) as `0x${string}`,
      to: getAddress(edge.to) as `0x${string}`,
    });
    if (!this.#roots.has(normalized.from.toLowerCase())) {
      throw new Error("address graph auto-expansion is limited to one approved hop");
    }
    if (edge.relationshipType === "FUNDED_BY" && edge.reviewState !== "APPROVED") {
      throw new Error("unreviewed funding cannot expand the official address cluster");
    }
    const key = `${normalized.from}:${normalized.to}:${normalized.relationshipType}:${normalized.sourceTxHash}`;
    if (this.#edges.has(key)) return false;
    this.#edges.set(key, normalized);
    return true;
  }

  approvedAddresses(): readonly `0x${string}`[] {
    const addresses = new Set<string>(this.#roots);
    for (const edge of this.#edges.values()) {
      if (edge.reviewState === "APPROVED") addresses.add(edge.to.toLowerCase());
    }
    return Object.freeze([...addresses].map((address) => getAddress(address) as `0x${string}`));
  }

  edges(): readonly AddressGraphEdge[] {
    return Object.freeze([...this.#edges.values()]);
  }

  observeDeployment(receipt: DeploymentReceiptObservation): AddressCandidateAlert | null {
    if (receipt.status !== "SUCCESS" || receipt.to !== null || receipt.contractAddress === null) {
      return null;
    }
    const from = getAddress(receipt.from).toLowerCase();
    if (!this.#roots.has(from)) return null;
    const candidateAddress = getAddress(receipt.contractAddress) as `0x${string}`;
    this.add({
      from: getAddress(receipt.from) as `0x${string}`,
      to: candidateAddress,
      relationshipType: "DEPLOYED_BY",
      sourceTxHash: receipt.transactionHash,
      observedBlock: receipt.blockNumber,
      reviewState: "PENDING",
    });
    return Object.freeze({
      alertId: `${this.config.clusterId}:${this.config.revision}:${receipt.transactionHash}`,
      clusterId: this.config.clusterId,
      clusterRevision: this.config.revision,
      candidateAddress,
      reason: "ROOT_CONTRACT_DEPLOYMENT",
      sourceTxHash: receipt.transactionHash,
      sourceBlock: receipt.blockNumber,
      reviewState: "PENDING",
    });
  }

  observeAdminTransaction(observation: AdminTransactionObservation): AddressCandidateAlert | null {
    if (observation.status !== "SUCCESS" || observation.to === null) return null;
    const from = getAddress(observation.from);
    if (!this.#roots.has(from.toLowerCase())) return null;
    const candidateAddress = getAddress(observation.to) as `0x${string}`;
    this.add({
      from: from as `0x${string}`,
      to: candidateAddress,
      relationshipType: observation.relationshipType,
      sourceTxHash: observation.transactionHash,
      observedBlock: observation.blockNumber,
      reviewState: "PENDING",
    });
    return Object.freeze({
      alertId: `${this.config.clusterId}:${this.config.revision}:${observation.transactionHash}`,
      clusterId: this.config.clusterId,
      clusterRevision: this.config.revision,
      candidateAddress,
      reason: "APPROVED_ADMIN_CHANGE",
      sourceTxHash: observation.transactionHash,
      sourceBlock: observation.blockNumber,
      reviewState: "PENDING",
    });
  }
}
