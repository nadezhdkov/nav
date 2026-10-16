import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SandboxHandle } from "@navarch/contracts";
import { git } from "./git.ts";
import { branchName, commitAll, createWorktree, NAVARCH_IDENTITY, type WorktreeSpec } from "./worktree.ts";

/**
 * Parallel team members (ADR 0029): each works in its own worktree, forked from the run's shared
 * one, and its branch is merged back by Navarch. Navarch's git writes to one repository's
 * worktrees run one at a time.
 */

const queues = new Map<string, Promise<unknown>>();

/** Runs `fn` after every earlier call with the same key has settled. */
export function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = queues.get(key) ?? Promise.resolve();
  const run = before.then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

const repoKey = (repoPath: string) => resolve(repoPath);

/**
 * A member's worktree. A new one starts from the shared worktree's HEAD, after its uncommitted
 * work is committed, so the member sees the lead's edits and the merged work it depends on. An
 * existing branch keeps its fork point (its merge base with the shared branch).
 */
export function forkWorktree(spec: WorktreeSpec & { from: SandboxHandle }): Promise<SandboxHandle & { reused: boolean }> {
  return serialized(repoKey(spec.repoPath), async () => {
    const branch = branchName(spec.runId, spec.taskSlug);
    const exists = await git(spec.repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(
      () => true,
      () => false,
    );
    let baseCommit = spec.baseCommit;
    if (exists) baseCommit = (await git(spec.repoPath, ["merge-base", branch, spec.from.branch])).trim();
    else if (existsSync(join(spec.from.path, ".git"))) {
      // A merge waiting for its conflicts to be resolved is not committed: the member forks from before it.
      baseCommit = (await merging(spec.from.path))
        ? (await git(spec.from.path, ["rev-parse", "HEAD"])).trim()
        : await commitAll(spec.from, "navarch: the team's work before members fork");
    }
    return createWorktree({ ...spec, baseCommit });
  });
}

export type MergeResult = { merged: true } | { merged: false; conflicts: string[] };

type MergeSpec = { repoPath: string; target: SandboxHandle; source: Pick<SandboxHandle, "path" | "branch">; message: string };

/**
 * Commits the member's work and merges its branch into the shared worktree (`--no-ff`). On a
 * conflict the merge stays in progress, for an agent to remove the markers.
 */
export function mergeBranch(spec: MergeSpec): Promise<MergeResult> {
  return serialized(repoKey(spec.repoPath), async () => {
    if (existsSync(join(spec.source.path, ".git"))) await commitAll(spec.source, `${spec.message}: the member's work`);
    if (await merging(spec.target.path)) return { merged: false, conflicts: await unmerged(spec.target.path) };
    await commitAll(spec.target, "navarch: the team's work before a merge");
    if (await isAncestor(spec.target.path, spec.source.branch)) return { merged: true };
    try {
      await git(spec.target.path, ["merge", "--no-ff", "--no-verify", "-m", spec.message, spec.source.branch], NAVARCH_IDENTITY);
      return { merged: true };
    } catch (err) {
      const conflicts = await unmerged(spec.target.path);
      if (!conflicts.length) {
        if (await merging(spec.target.path)) await git(spec.target.path, ["merge", "--abort"]);
        throw err;
      }
      return { merged: false, conflicts };
    }
  });
}

const MARKER = /^(<{7}|>{7})( |$)|^={7}$/m;

/**
 * After an agent edited the conflicted files: concludes the merge when none still holds a marker
 * line, and aborts it otherwise.
 */
export function concludeMerge(spec: Omit<MergeSpec, "message"> & { files: string[] }): Promise<MergeResult> {
  return serialized(repoKey(spec.repoPath), async () => {
    const cwd = spec.target.path;
    if (!(await merging(cwd))) return (await isAncestor(cwd, spec.source.branch)) ? { merged: true } : { merged: false, conflicts: spec.files };
    const marked: string[] = [];
    for (const file of spec.files) {
      const text = await readFile(join(cwd, file), "utf8").catch(() => "");
      if (MARKER.test(text)) marked.push(file);
    }
    if (marked.length) {
      await git(cwd, ["merge", "--abort"]);
      return { merged: false, conflicts: marked };
    }
    await git(cwd, ["add", "--all"]);
    await git(cwd, ["commit", "--no-verify", "--no-edit", "-q"], NAVARCH_IDENTITY);
    return { merged: true };
  });
}

async function merging(cwd: string): Promise<boolean> {
  return git(cwd, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).then(
    () => true,
    () => false,
  );
}

async function unmerged(cwd: string): Promise<string[]> {
  return (await git(cwd, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
}

async function isAncestor(cwd: string, branch: string): Promise<boolean> {
  return git(cwd, ["merge-base", "--is-ancestor", branch, "HEAD"]).then(
    () => true,
    () => false,
  );
}
