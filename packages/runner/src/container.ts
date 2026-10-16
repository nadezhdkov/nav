import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { ContainerIsolation } from "@navarch/contracts";
import { git } from "./git.ts";
import { runProcess, type ShellOptions } from "./shell.ts";

/**
 * Isolation level L2 (spec §6.5.1, ADR 0035): one operator command (a verify check or a setup
 * command) in a throwaway container of the run's image, with only the worktree mounted.
 */
export type ContainerCommand = {
  /** The runtime's command, `docker` or `podman` (they take the same flags). */
  runtime: string;
  isolation: ContainerIsolation;
  /** Overrides `isolation.network` (setup commands install dependencies). */
  network?: "none" | "bridge";
  /** Unique per command, so a timeout or cancel can remove it. */
  name: string;
  worktree: string;
  /** The repository's git directory, mounted read-only so git works inside. */
  gitDir?: string;
  user: { uid: number; gid: number };
};

/** Only these reach the container: nothing from the daemon's environment, so no secret (T3). */
export const CONTAINER_ENV: Record<string, string> = { HOME: "/tmp", CI: "1", GIT_OPTIONAL_LOCKS: "0", NAVARCH_SANDBOX: "container" };

export function containerArgs(spec: ContainerCommand, command: string): string[] {
  const { isolation } = spec;
  const mounts = [`--volume=${spec.worktree}:${spec.worktree}:rw`];
  if (spec.gitDir && !spec.worktree.startsWith(`${spec.gitDir}/`)) mounts.push(`--volume=${spec.gitDir}:${spec.gitDir}:ro`);
  return [
    "run", "--rm", "--init", `--name=${spec.name}`, "--pull=missing",
    `--network=${spec.network ?? isolation.network}`,
    `--user=${spec.user.uid}:${spec.user.gid}`,
    "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--read-only", "--tmpfs=/tmp:rw,exec,nosuid,size=1g",
    `--memory=${isolation.memory}`, `--cpus=${isolation.cpus}`, `--pids-limit=${isolation.pids_limit}`,
    ...mounts, `--workdir=${spec.worktree}`,
    ...Object.entries(CONTAINER_ENV).map(([k, v]) => `--env=${k}=${v}`),
    isolation.image, "sh", "-c", command,
  ];
}

/** Runs `command` in the container; like `runShell`, the code is null when it was killed. */
export function runInContainer(spec: ContainerCommand, command: string, options: Omit<ShellOptions, "cwd" | "env">): Promise<{ code: number | null; tail: string }> {
  return runProcess(spec.runtime, containerArgs(spec, command), {
    ...options,
    cwd: spec.worktree,
    // The runtime's client needs its own environment (DOCKER_HOST, XDG_RUNTIME_DIR); the container gets none of it.
    env: process.env,
    // Killing the client leaves the container running: remove it.
    onKill: () => {
      spawn(spec.runtime, ["rm", "--force", spec.name], { stdio: "ignore" }).on("error", () => {});
    },
  });
}

/** Undefined when the runtime answers; otherwise why it cannot run containers. */
export async function containerRuntimeProblem(runtime: string): Promise<string | undefined> {
  const { code, tail } = await runProcess(runtime, ["version"], { cwd: process.cwd(), env: process.env, timeoutMs: 15_000, onOutput: () => {} });
  if (code === 0) return undefined;
  return `\`${runtime} version\` ${code === null ? "timed out" : `exited with ${code}`}${tail ? `: ${tail}` : ""}`;
}

/** The git directory shared by a worktree and its repository. */
export async function gitCommonDir(worktree: string): Promise<string> {
  const dir = (await git(worktree, ["rev-parse", "--git-common-dir"])).trim();
  return isAbsolute(dir) ? dir : resolve(worktree, dir);
}

/** The daemon's own user: files a container writes to the worktree belong to the operator. */
export function hostUser(): { uid: number; gid: number } {
  return { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 };
}
