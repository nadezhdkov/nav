import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { SandboxHandle } from "@vectr/contracts";
import { git } from "./git.ts";

/** L1 isolation: one git worktree per task (spec §6.5.1, §6.5.2). */

export type WorktreeSpec = {
  sandboxId: string;
  repoPath: string;
  runId: string;
  taskSlug: string;
  baseCommit: string;
  /** VECTR home, normally `~/.vectr`. */
  home: string;
};

export function branchName(runId: string, taskSlug: string): string {
  return `vectr/${runId}/${taskSlug}`;
}

export function worktreePath(home: string, repoPath: string, runId: string, taskSlug: string): string {
  return join(home, "worktrees", basename(resolve(repoPath)), `${runId}-${taskSlug}`);
}

export async function resolveRepoRoot(path: string): Promise<string> {
  return (await git(path, ["rev-parse", "--show-toplevel"])).trim();
}

export async function resolveHead(repoPath: string): Promise<string> {
  return (await git(repoPath, ["rev-parse", "HEAD"])).trim();
}

/**
 * Creates the worktree, or reuses it when it already exists (a retried or resumed task
 * continues on the same files).
 */
export async function createWorktree(spec: WorktreeSpec): Promise<SandboxHandle & { reused: boolean }> {
  const branch = branchName(spec.runId, spec.taskSlug);
  const path = worktreePath(spec.home, spec.repoPath, spec.runId, spec.taskSlug);
  const handle = { id: spec.sandboxId, kind: "worktree" as const, path, branch, baseCommit: spec.baseCommit };

  if (existsSync(join(path, ".git"))) {
    const current = (await git(path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current !== branch) throw new Error(`worktree ${path} is on ${current}, expected ${branch}`);
    return { ...handle, reused: true };
  }

  await mkdir(join(spec.home, "worktrees", basename(resolve(spec.repoPath))), { recursive: true });
  const branchExists = await git(spec.repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );
  const args = branchExists
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, spec.baseCommit];
  await git(spec.repoPath, args);
  return { ...handle, reused: false };
}

/** Diff of everything the task changed since the base commit, untracked files included. */
export async function worktreeDiff(sandbox: SandboxHandle): Promise<string> {
  await git(sandbox.path, ["add", "--all", "--intent-to-add"]);
  return git(sandbox.path, ["diff", "--binary", sandbox.baseCommit]);
}

export async function changedFiles(sandbox: SandboxHandle): Promise<string[]> {
  await git(sandbox.path, ["add", "--all", "--intent-to-add"]);
  const out = await git(sandbox.path, ["diff", "--name-only", sandbox.baseCommit]);
  return out.split("\n").filter(Boolean);
}

export async function removeWorktree(repoPath: string, sandbox: SandboxHandle): Promise<void> {
  await git(repoPath, ["worktree", "remove", "--force", sandbox.path]);
}
