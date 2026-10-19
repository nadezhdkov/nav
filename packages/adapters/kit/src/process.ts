import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { sandboxFor, type SandboxedCli } from "./sandbox.ts";

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

type Entry = { child: ChildProcess; cancelled: boolean; onKill?: () => void };

export class CliProcesses {
  private readonly running = new Map<string, Entry>();
  private readonly killGraceMs: number;
  /** Tasks whose sandbox is being prepared; a cancel that arrives then ends the task before it starts. */
  private readonly preparing = new Map<string, { cancelled: boolean }>();

  constructor(killGraceMs = 5_000) {
    this.killGraceMs = killGraceMs;
  }

  run(spec: CliRun): Promise<CliExit> {
    // PWD follows cwd: some CLIs (OpenCode) take their project directory from $PWD, and an
    // inherited one points at the daemon's directory instead of the task's worktree.
    const sandbox = sandboxFor(spec.taskId);
    if (!sandbox) return this.start(spec, { command: spec.command, args: spec.args, env: { ...spec.env, PWD: spec.cwd }, cwd: spec.cwd });
    const pending = { cancelled: false };
    this.preparing.set(spec.taskId, pending);
    return sandbox({ ...spec, env: { ...spec.env, PWD: spec.cwd } }).then(
      (wrapped) => {
        this.preparing.delete(spec.taskId);
        if (!pending.cancelled) return this.start(spec, wrapped);
        void Promise.resolve(wrapped.onExit?.()).catch(() => {});
        return { code: null, signal: null, stderr: "", cancelled: true, timedOut: false };
      },
      (err: Error) => {
        this.preparing.delete(spec.taskId);
        // Not sandboxable (no runtime, no image): the task fails; the CLI never runs unsandboxed.
        return { code: null, signal: null, stderr: "", spawnError: err, cancelled: pending.cancelled, timedOut: false };
      },
    );
  }

  private start(spec: CliRun, wrapped: SandboxedCli): Promise<CliExit> {
    const child = spawn(wrapped.command, wrapped.args, { cwd: wrapped.cwd, env: wrapped.env, stdio: ["pipe", "pipe", "pipe"] });
    const entry: Entry = { child, cancelled: false, ...(wrapped.onKill ? { onKill: wrapped.onKill } : {}) };
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
            void this.kill(child, entry.onKill);
          }, spec.timeoutMs)
        : undefined;

    return new Promise((resolve) => {
      child.on("error", (err) => (spawnError = err));
      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        this.running.delete(spec.taskId);
        lines.close();
        void Promise.resolve(wrapped.onExit?.()).catch(() => {});
        resolve({ code, signal, stderr, spawnError, cancelled: entry.cancelled, timedOut });
      });
    });
  }

  async cancel(taskId: string): Promise<void> {
    const pending = this.preparing.get(taskId);
    if (pending) pending.cancelled = true;
    const entry = this.running.get(taskId);
    if (!entry) return;
    entry.cancelled = true;
    await this.kill(entry.child, entry.onKill);
  }

  /** Stops every running subprocess without marking it cancelled (daemon shutdown). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.running.values()].map((entry) => this.kill(entry.child, entry.onKill)));
  }

  private kill(child: ChildProcess, onKill?: () => void): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const force = setTimeout(() => {
        onKill?.();
        child.kill("SIGKILL");
      }, this.killGraceMs);
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
