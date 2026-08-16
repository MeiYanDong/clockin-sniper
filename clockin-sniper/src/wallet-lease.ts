import { open, mkdir, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

export class FileWalletLease {
  readonly #path: string;
  readonly #handle: FileHandle;
  #released = false;

  private constructor(path: string, handle: FileHandle) {
    this.#path = path;
    this.#handle = handle;
  }

  static async acquire(
    path: string,
    metadata: { readonly walletAddress: string; readonly launchId: string },
  ): Promise<FileWalletLease> {
    await mkdir(dirname(path), { recursive: true });
    let handle: FileHandle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new Error(`wallet lease already exists at ${path}`);
      }
      throw error;
    }
    try {
      await handle.writeFile(
        `${JSON.stringify({
          pid: process.pid,
          walletAddress: metadata.walletAddress,
          launchId: metadata.launchId,
          acquiredAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    }
    return new FileWalletLease(path, handle);
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    await this.#handle.close();
    await unlink(this.#path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
