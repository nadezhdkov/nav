import { spawn } from "node:child_process";

export type ShellOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onOutput: (chunk: string) => void;
};

/**
 * Runs an operator-supplied command through `sh -c` (sandbox setup, spec §14.2 `setup`), streaming
 * its output. Resolves with the exit code (null when killed on timeout) and the last output, on one line.
 */
export function runShell(command: string, options: ShellOptions): Promise<{ code: number | null; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const take = (data: Buffer | string) => {
      const chunk = data.toString();
      options.onOutput(chunk);
      tail = (tail + chunk).slice(-500);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.on("error", (err) => take(String(err)));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? null : code, tail: tail.trim().replace(/\s+/g, " ") });
    });
  });
}
