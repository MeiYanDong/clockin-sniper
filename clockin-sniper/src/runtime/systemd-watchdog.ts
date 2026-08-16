import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SystemdNotifyRunner = (args: readonly string[]) => Promise<void>;

async function defaultRunner(args: readonly string[]): Promise<void> {
  await execFileAsync("/usr/bin/systemd-notify", [...args], {
    timeout: 2_000,
    windowsHide: true,
  });
}

export class SystemdWatchdog {
  readonly #enabled: boolean;
  readonly #intervalMs: number;
  readonly #runner: SystemdNotifyRunner;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(env: NodeJS.ProcessEnv = process.env, runner: SystemdNotifyRunner = defaultRunner) {
    this.#enabled = (env.NOTIFY_SOCKET?.length ?? 0) > 0;
    const watchdogUsec = Number(env.WATCHDOG_USEC ?? "0");
    this.#intervalMs =
      Number.isFinite(watchdogUsec) && watchdogUsec > 0
        ? Math.max(250, Math.min(10_000, Math.floor(watchdogUsec / 2_000)))
        : 10_000;
    this.#runner = runner;
  }

  async ready(status: string): Promise<void> {
    if (!this.#enabled) return;
    await this.#notify(["--ready", `--pid=${process.pid}`, `--status=${status}`]);
    this.#startHeartbeat();
  }

  async status(status: string): Promise<void> {
    if (!this.#enabled) return;
    await this.#notify([`--pid=${process.pid}`, `--status=${status}`]);
  }

  async stopping(status: string): Promise<void> {
    if (!this.#enabled) return;
    this.stop();
    await this.#notify(["--stopping", `--pid=${process.pid}`, `--status=${status}`]);
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  #startHeartbeat(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      if (this.#running) return;
      this.#running = true;
      void this.#notify(["--watchdog", `--pid=${process.pid}`]).finally(() => {
        this.#running = false;
      });
    }, this.#intervalMs);
    this.#timer.unref();
  }

  async #notify(args: readonly string[]): Promise<void> {
    await this.#runner(args);
  }
}
