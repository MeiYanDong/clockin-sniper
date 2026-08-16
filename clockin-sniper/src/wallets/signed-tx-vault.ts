import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { getBytes, keccak256 } from "ethers";

interface VaultEnvelope {
  readonly version: 1;
  readonly txHash: `0x${string}`;
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
  readonly createdAt: string;
}

function keyBytes(key: Uint8Array): Buffer {
  if (key.length !== 32) throw new RangeError("vault encryption key must be 32 bytes");
  return Buffer.from(key);
}

export class SignedTxVault {
  readonly #directory: string;
  readonly #key: Buffer;

  constructor(directory: string, key: Uint8Array) {
    this.#directory = resolve(directory);
    this.#key = keyBytes(key);
  }

  async put(rawTransaction: `0x${string}`, createdAt: string): Promise<string> {
    const rawBytes = getBytes(rawTransaction);
    const txHash = keccak256(rawBytes) as `0x${string}`;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(rawBytes), cipher.final()]);
    const envelope: VaultEnvelope = Object.freeze({
      version: 1,
      txHash,
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      createdAt,
    });
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const reference = join(this.#directory, `${txHash.slice(2)}.vault`);
    await writeFile(reference, `${JSON.stringify(envelope)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(reference, 0o600);
    return reference;
  }

  async get(reference: string, expectedTxHash: `0x${string}`): Promise<`0x${string}`> {
    const absolute = resolve(reference);
    if (dirname(absolute) !== this.#directory) throw new Error("vault reference escapes directory");
    const envelope = JSON.parse(await readFile(absolute, "utf8")) as VaultEnvelope;
    if (envelope.txHash.toLowerCase() !== expectedTxHash.toLowerCase()) {
      throw new Error("vault metadata txHash mismatch");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
    const rawBytes = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    const actualHash = keccak256(rawBytes);
    if (actualHash.toLowerCase() !== expectedTxHash.toLowerCase()) {
      throw new Error("decrypted raw transaction hash mismatch");
    }
    return `0x${rawBytes.toString("hex")}`;
  }

  async remove(reference: string): Promise<void> {
    const absolute = resolve(reference);
    if (dirname(absolute) !== this.#directory) throw new Error("vault reference escapes directory");
    await rm(absolute, { force: true });
  }

  async cleanup(
    reference: string,
    evidence: Readonly<{
      canonicalReceiptFinal: boolean;
      validityExpired: boolean;
      nonce: bigint;
      latestNonce: bigint;
      pendingNonce: bigint;
      droppedProven: boolean;
    }>,
  ): Promise<"REMOVED" | "RETAINED"> {
    const nonceConsumed =
      evidence.latestNonce > evidence.nonce && evidence.pendingNonce > evidence.nonce;
    const safeAfterExpiry = evidence.validityExpired && (nonceConsumed || evidence.droppedProven);
    if (!evidence.canonicalReceiptFinal && !safeAfterExpiry) return "RETAINED";
    await this.remove(reference);
    return "REMOVED";
  }
}
