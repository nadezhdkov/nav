import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/** Shared subprocess handling for adapters that drive an agent CLI (claude, gemini, codex). */

export type CliRun = {
  taskId: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  onLine: (line: string) => void;
};

export type CliExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  spawnError?: Error;
  cancelled: boolean;
  timedOut: boolean;
};

type Entry = { child: ChildProcess; cancelled: boolean };

export class CliProcesses {
  private readonly running = new Map<string, Entry>();
  private readonly killGraceMs: number;

  constructor(killGraceMs = 5_000) {
    this.killGraceMs = killGraceMs;
  }

  run(spec: CliRun): Promise<CliExit> {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
    const entry: Entry = { child, cancelled: false };
    this.running.set(spec.taskId, entry);

    let stderr = "";
    let spawnError: Error | undefined;
    let timedOut = false;

    child.stdin?.on("error", () => {
      // The CLI may exit before reading stdin; that is reported through its exit code.
    });
    child.stdin?.end(spec.stdin ?? "");
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8_000);
    });
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", spec.onLine);

    const timer =
      spec.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            void this.kill(child);
          }, spec.timeoutMs)
        : undefined;

    return new Promise((resolve) => {
      child.on("error", (err) => (spawnError = err));
      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        this.running.delete(spec.taskId);
        lines.close();
        resolve({ code, signal, stderr, spawnError, cancelled: entry.cancelled, timedOut });
      });
    });
  }

  async cancel(taskId: string): Promise<void> {
    const entry = this.running.get(taskId);
    if (!entry) return;
    entry.cancelled = true;
    await this.kill(entry.child);
  }

  /** Stops every running subprocess without marking it cancelled (daemon shutdown). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.running.values()].map((entry) => this.kill(entry.child)));
  }

  private kill(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const force = setTimeout(() => child.kill("SIGKILL"), this.killGraceMs);
      child.once("close", () => {
        clearTimeout(force);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}

export function healthcheck(command: string, args: string[]): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.on("error", (err) => resolve({ ok: false, detail: err.message }));
    child.on("close", (code) => resolve({ ok: code === 0, detail: out.trim().split("\n")[0] || `exit ${code}` }));
  });
}
