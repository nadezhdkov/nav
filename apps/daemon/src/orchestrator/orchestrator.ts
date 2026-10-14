import { resolve } from "node:path";
import {
  isTerminalRun,
  isTerminalTask,
  newId,
  type Actor,
  type CreateRunRequest,
  type TaskError,
  type NewEvent,
  type RunStatus,
  type RunView,
  type TaskStatus,
} from "@vectr/contracts";
import { resolveHead, resolveRepoRoot } from "@vectr/runner";
import type { Config } from "../config.ts";
import type { EventStore } from "../events/store.ts";
import { implementer } from "./profiles.ts";

export class OrchestratorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const system = (component: string): Actor => ({ kind: "system", component });

/**
 * Orchestrator (spec §6.1.1). Phase 0 has no Flow engine yet: every run is a one-node TaskGraph
 * (`implement`) executed by the default adapter. Status changes are always written as events.
 */
export class Orchestrator {
  private readonly store: EventStore;
  private readonly config: Config;
  private readonly adapters: string[];
  private readonly onReady: () => void;

  constructor(store: EventStore, config: Config, adapters: string[], onReady: () => void) {
    this.store = store;
    this.config = config;
    this.adapters = adapters;
    this.onReady = onReady;
  }

  async startRun(req: CreateRunRequest, actor: Actor): Promise<RunView> {
    const adapter = req.adapter ?? this.config.default_adapter;
    if (!this.adapters.includes(adapter)) {
      throw new OrchestratorError(
        "unknown_adapter",
        `adapter "${adapter}" is not enabled; available: ${this.adapters.join(", ") || "none"}`,
      );
    }
    const model = req.model ?? this.config.adapters[adapter].model;
    let repoPath: string;
    let baseCommit: string;
    try {
      repoPath = await resolveRepoRoot(resolve(req.repo_path));
      baseCommit = await resolveHead(repoPath);
    } catch {
      throw new OrchestratorError("invalid_repo", `${req.repo_path} is not a git repository with at least one commit`);
    }

    const runId = newId("run");
    const taskId = newId("task");
    this.store.append([
      {
        type: "run.created",
        run_id: runId,
        task_id: null,
        actor,
        payload: {
          repo_path: repoPath,
          base_commit: baseCommit,
          prompt: req.prompt,
          budget: req.budget ?? this.config.budgets.default_run,
          adapter,
          profile: implementer.id,
          allow_commands: [...this.config.allow_commands, ...(req.allow_commands ?? [])],
          ...(model ? { model } : {}),
        },
      },
      {
        type: "task.created",
        run_id: runId,
        task_id: taskId,
        actor: system("orchestrator"),
        payload: {
          node_id: "implement",
          type: "agent",
          profile: implementer.id,
          adapter,
          max_attempts: this.config.scheduler.max_attempts,
        },
      },
      taskStatus(runId, taskId, "pending", "ready", 0, "dependencies satisfied"),
    ]);
    this.onReady();
    return this.store.getRun(runId)!;
  }

  /** Cancels pending work directly; running tasks are stopped by the scheduler, which records the result. */
  cancelRun(runId: string, actor: Actor, cancelRunning: (taskId: string) => void): RunView {
    const run = this.store.getRun(runId);
    if (!run) throw new OrchestratorError("not_found", `run ${runId} not found`);
    if (isTerminalRun(run.status)) throw new OrchestratorError("conflict", `run ${runId} is already ${run.status}`);

    const events: NewEvent[] = [];
    for (const task of this.store.tasksOfRun(runId)) {
      if (task.status === "running") cancelRunning(task.id);
      else if (!isTerminalTask(task.status) && task.status !== "cancelled") {
        events.push(taskStatus(runId, task.id, task.status, "cancelled", task.attempt, "run cancelled by user"));
      }
    }
    events.push(runStatus(runId, run.status, "cancelled", "cancelled by user", actor));
    this.store.append(events);
    return this.store.getRun(runId)!;
  }

  /**
   * Continues a paused run (spec §10, `/runs/:id/resume`): its failed tasks are requeued and
   * keep their resume token, so the agent continues the same conversation.
   */
  resumeRun(runId: string, actor: Actor): RunView {
    const run = this.store.getRun(runId);
    if (!run) throw new OrchestratorError("not_found", `run ${runId} not found`);
    if (run.status !== "paused") throw new OrchestratorError("conflict", `run ${runId} is ${run.status}, not paused`);

    const events: NewEvent[] = [runStatus(runId, "paused", "executing", "resumed by user", actor)];
    for (const task of this.store.tasksOfRun(runId)) {
      if (task.status === "failed") events.push(taskStatus(runId, task.id, "failed", "ready", task.attempt, "run resumed by user"));
    }
    this.store.append(events);
    this.onReady();
    return this.store.getRun(runId)!;
  }

  /**
   * Called on startup (spec §5.4): tasks left `running` by a previous process are marked
   * `interrupted` and requeued while attempts remain.
   */
  recover(): number {
    const stale = this.store.tasksWithStatus("running");
    for (const task of stale) {
      const events: NewEvent[] = [
        taskStatus(task.run_id, task.id, "running", "interrupted", task.attempt, "daemon restarted", {
          kind: "interrupted",
          message: "daemon stopped while the task was running",
        }),
      ];
      if (task.attempt < task.max_attempts) {
        events.push(taskStatus(task.run_id, task.id, "interrupted", "ready", task.attempt, "retry after interruption"));
      } else {
        events.push(taskStatus(task.run_id, task.id, "interrupted", "failed", task.attempt, "no attempts left"));
        const run = this.store.getRun(task.run_id);
        if (run && !isTerminalRun(run.status)) events.push(runStatus(task.run_id, run.status, "failed", "task failed"));
      }
      this.store.append(events);
    }
    if (stale.length) this.onReady();
    return stale.length;
  }
}

export function taskStatus(
  runId: string,
  taskId: string,
  from: TaskStatus,
  to: TaskStatus,
  attempt: number,
  reason?: string,
  error?: TaskError,
  notBefore?: string,
): NewEvent {
  return {
    type: "task.status_changed",
    run_id: runId,
    task_id: taskId,
    actor: system("scheduler"),
    payload: {
      from,
      to,
      attempt,
      ...(reason ? { reason } : {}),
      ...(error ? { error } : {}),
      ...(notBefore ? { not_before: notBefore } : {}),
    },
  };
}

export function runStatus(runId: string, from: RunStatus, to: RunStatus, reason?: string, actor?: Actor): NewEvent {
  return {
    type: "run.status_changed",
    run_id: runId,
    task_id: null,
    actor: actor ?? system("orchestrator"),
    payload: { from, to, ...(reason ? { reason } : {}) },
  };
}
