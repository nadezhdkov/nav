import { spawn, type ChildProcess } from "node:child_process";

export type ShellOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onOutput: (chunk: string) => void;
  /** Aborting kills the command (task cancelled or daemon stopping). */
  signal?: AbortSignal;
};

/**
 * Runs an operator-supplied command through `sh -c` (sandbox setup, spec §14.2 `setup`), streaming
 * its output. Resolves with the exit code (null when killed on timeout or abort) and the last output,
 * on one line. The command runs in its own process group so that killing it also ends what it started.
 */
export function runShell(command: string, options: ShellOptions): Promise<{ code: number | null; tail: string }> {
  return runProcess("sh", ["-c", command], options);
}

/**
 * `runShell` for any program and arguments. `onKill` runs once when the command is killed on
 * timeout or abort, for what lives outside its process group (a container, ADR 0035).
 */
export function runProcess(file: string, args: string[], options: ShellOptions & { onKill?: () => void }): Promise<{ code: number | null; tail: string }> {
  if (options.signal?.aborted) return Promise.resolve({ code: null, tail: "" });
  return new Promise((resolve) => {
    let killed = false;
    const kill = (child: ChildProcess, signal: NodeJS.Signals) => {
      if (!killed) options.onKill?.();
      killed = true;
      killGroup(child, signal);
    };
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let tail = "";
    const take = (data: Buffer | string) => {
      const chunk = data.toString();
      options.onOutput(chunk);
      tail = (tail + chunk).slice(-500);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => kill(child, "SIGKILL"), options.timeoutMs);
    let force: NodeJS.Timeout | undefined;
    const onAbort = () => {
      kill(child, "SIGTERM");
      force = setTimeout(() => killGroup(child, "SIGKILL"), 2_000);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => take(String(err)));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(force);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ code: signal || killed ? null : code, tail: tail.trim().replace(/\s+/g, " ") });
    });
  });
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
}
