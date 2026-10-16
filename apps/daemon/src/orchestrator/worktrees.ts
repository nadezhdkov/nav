import type { CompeteTaskRef, TeamTaskRef } from "@navarch/contracts";

type Refs = { team?: TeamTaskRef | null; compete?: CompeteTaskRef | null };

/**
 * The key of a task's own worktree, `navarch/<run>/<flow>-<key>`, forked from the run's shared one:
 * a parallel team member's (ADR 0029) or a competitor's (ADR 0031). Undefined for tasks that work
 * in the run's shared worktree.
 */
export function ownWorktreeKey(task: Refs): string | undefined {
  if (task.team?.own_worktree && task.team.key) return task.team.key;
  if (task.compete?.role === "competitor" && task.compete.key) return task.compete.key;
  return undefined;
}

/** Whether a task works in a worktree of its own rather than the run's shared one. */
export const ownsWorktree = (task: Refs): boolean => ownWorktreeKey(task) !== undefined;
