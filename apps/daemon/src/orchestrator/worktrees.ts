import type { CompeteTaskRef, TeamTaskRef } from "@navarch/contracts";

type Refs = { team?: TeamTaskRef | null; compete?: CompeteTaskRef | null };

/**
 * The key of a task's own worktree, `navarch/<run>/<flow>-<key>`, forked from the run's shared one:
 * a parallel team member's (ADR 0029), a sub-lead's (ADR 0058) or a competitor's (ADR 0031). Undefined for tasks that work
 * in the run's shared worktree.
 */
export function ownWorktreeKey(task: Refs): string | undefined {
  // A sub-lead's team (ADR 0058): the sub-lead and whatever works on its behalf share the worktree
  // `<sub>`; each of its members has `<sub>.<key>`, forked from it. Checks and merges have none.
  const sub = task.team?.sub;
  if (sub) {
    if (task.team?.role === "member" && task.team.key) return `${sub}.${task.team.key}`;
    return task.team?.role === "lead" || task.team?.role === "integrate" ? sub : undefined;
  }
  if (task.team?.own_worktree && task.team.key) return task.team.key;
  if (task.compete?.role === "competitor" && task.compete.key) return task.compete.key;
  return undefined;
}

/** Whether a task works in a worktree of its own rather than the run's shared one. */
export const ownsWorktree = (task: Refs): boolean => ownWorktreeKey(task) !== undefined;
