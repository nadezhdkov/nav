import type { CliRun } from "./process.ts";

/**
 * Where an agent CLI runs (spec §6.5.1, ADR 0069). Every CLI adapter starts its process through
 * `CliProcesses`, so one hook per task is enough to put any of them in a container: the Agent Runtime
 * registers a `CliSandbox` for the task before the adapter starts, and `CliProcesses.run` asks it to
 * rewrite the command. Adapters need no change and cannot start a process outside it.
 */
export type SandboxedCli = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Called when the process is killed (timeout, cancel, shutdown): killing a container's client leaves the container. */
  onKill?: () => void;
  /** Called once the process ended, or when it never started. */
  onExit?: () => void | Promise<void>;
};

/** Rewrites one agent process; throws when it cannot be sandboxed, which fails the task and never falls back to the host. */
export type CliSandbox = (run: CliRun) => Promise<SandboxedCli>;

const sandboxes = new Map<string, CliSandbox>();

/** Sandboxes the processes of `taskId` until the returned function is called. */
export function useCliSandbox(taskId: string, sandbox: CliSandbox): () => void {
  sandboxes.set(taskId, sandbox);
  return () => {
    if (sandboxes.get(taskId) === sandbox) sandboxes.delete(taskId);
  };
}

export const sandboxFor = (taskId: string): CliSandbox | undefined => sandboxes.get(taskId);
