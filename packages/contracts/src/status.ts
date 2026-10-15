import { z } from "zod";

/** Task states, spec §8.3. */
export const TaskStatus = z.enum([
  "pending",
  "ready",
  "waiting_approval",
  "blocked",
  "running",
  "paused",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

const taskTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["ready", "cancelled"],
  ready: ["waiting_approval", "blocked", "running", "cancelled"],
  waiting_approval: ["ready", "cancelled"],
  blocked: ["ready", "cancelled"],
  running: ["succeeded", "failed", "interrupted", "paused", "cancelled"],
  paused: ["running", "cancelled"],
  interrupted: ["ready", "failed", "cancelled"],
  failed: ["ready"],
  succeeded: [],
  cancelled: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return taskTransitions[from].includes(to);
}

export function isTerminalTask(status: TaskStatus): boolean {
  return status === "succeeded" || status === "cancelled" || status === "failed";
}

/** Run states, spec §8.4: a main sequence plus side exits. */
export const RunStatus = z.enum([
  "created",
  "planning",
  "awaiting_approval",
  "executing",
  "verifying",
  "reviewing",
  "ready_for_pr",
  "pr_opened",
  "done",
  "failed",
  "cancelled",
  "paused",
  "budget_exceeded",
]);
export type RunStatus = z.infer<typeof RunStatus>;

const runSequence: readonly RunStatus[] = [
  "created",
  "planning",
  "awaiting_approval",
  "executing",
  "verifying",
  "reviewing",
  "ready_for_pr",
  "pr_opened",
  "done",
];
const runTerminal: readonly RunStatus[] = ["done", "failed", "cancelled"];
const runSideExits: readonly RunStatus[] = ["failed", "cancelled", "paused", "budget_exceeded"];

/**
 * A run moves forward along the main sequence (a Flow may skip stages it does not have; a fix
 * loop returns from `verifying` to `executing`),
 * may leave it through a side exit from any non-terminal state, and returns from
 * `paused`/`budget_exceeded` to a main-sequence state. A failed run returns to a main-sequence state
 * only when the user retries it (ADR 0025).
 */
export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  if (from === "failed") return runSequence.includes(to) && to !== "created" && to !== "done";
  if (from === to || runTerminal.includes(from)) return false;
  if (from === "paused" || from === "budget_exceeded") {
    return runSequence.includes(to) || to === "failed" || to === "cancelled";
  }
  if (runSideExits.includes(to)) return true;
  // A fix loop goes back from verification to implementation (spec §8.4).
  if (from === "verifying" && to === "executing") return true;
  const i = runSequence.indexOf(from);
  const j = runSequence.indexOf(to);
  return i >= 0 && j > i;
}

export function isTerminalRun(status: RunStatus): boolean {
  return runTerminal.includes(status);
}
