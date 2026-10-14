import type { AgentRuntime, TaskOutcome } from "@vectr/agent-runtime";
import { isTerminalRun, type Actor, type NewEvent } from "@vectr/contracts";
import type { Config } from "../config.ts";
import type { EventStore, TaskRecord } from "../events/store.ts";
import { runStatus, taskStatus } from "../orchestrator/orchestrator.ts";
import { buildInstructions, implementer } from "../orchestrator/profiles.ts";
import type { PolicyEngine } from "../policy/engine.ts";

const RETRYABLE = new Set(["transient", "rate_limited", "interrupted"]);
const scheduler: Actor = { kind: "system", component: "scheduler" };

export type CancelHook = (taskId: string) => Promise<void>;

/**
 * Scheduler (spec §6.1.2): picks `ready` tasks, asks the Policy Engine, dispatches them to the
 * Agent Runtime within the concurrency limit, and records the outcome. Phase 0: one global
 * limit, FIFO order, immediate retry for retryable errors.
 */
export class Scheduler {
  private readonly store: EventStore;
  private readonly runtime: AgentRuntime;
  private readonly policy: PolicyEngine;
  private readonly config: Config;
  private readonly cancelHook: CancelHook;
  private readonly active = new Map<string, Promise<void>>();
  private readonly cancelRequested = new Set<string>();
  private stopping = false;
  private pumping = false;

  constructor(deps: {
    store: EventStore;
    runtime: AgentRuntime;
    policy: PolicyEngine;
    config: Config;
    cancel: CancelHook;
  }) {
    this.store = deps.store;
    this.runtime = deps.runtime;
    this.policy = deps.policy;
    this.config = deps.config;
    this.cancelHook = deps.cancel;
  }

  get runningCount(): number {
    return this.active.size;
  }

  /** Dispatches ready tasks until the concurrency limit is reached. */
  pump(): void {
    if (this.stopping || this.pumping) return;
    this.pumping = true;
    try {
      for (const task of this.store.tasksWithStatus("ready")) {
        if (this.active.size >= this.config.scheduler.concurrency) break;
        if (this.active.has(task.id)) continue;
        this.dispatch(task);
      }
    } finally {
      this.pumping = false;
    }
  }

  requestCancel(taskId: string): void {
    this.cancelRequested.add(taskId);
    void this.cancelHook(taskId);
  }

  /** Stops dispatching and waits for running tasks to end without recording their results. */
  async stop(killAll: () => Promise<void>): Promise<void> {
    this.stopping = true;
    await killAll();
    await Promise.allSettled([...this.active.values()]);
  }

  /** Resolves once no task is running (used by tests and `vectr daemon stop`). */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active.values()]);
  }

  private dispatch(task: TaskRecord): void {
    const run = this.store.getRunRecord(task.run_id);
    if (!run) return;

    const decision = this.policy.decide(scheduler, "task.start", task.id, {
      autonomyLevel: this.config.autonomy_level,
      budgetRemaining: run.budget - run.cost_total,
    });
    if (decision.effect !== "allow") {
      this.store.append([
        {
          type: "policy.denied",
          run_id: run.id,
          task_id: task.id,
          actor: scheduler,
          payload: { action: "task.start", resource: task.id, reason: decision.reason },
        },
        taskStatus(run.id, task.id, "ready", "blocked", task.attempt, decision.reason),
      ]);
      return;
    }

    const attempt = task.attempt + 1;
    const events: NewEvent[] = [taskStatus(run.id, task.id, "ready", "running", attempt)];
    if (run.status === "created") events.push(runStatus(run.id, "created", "executing", "task dispatched"));
    this.store.append(events);

    const work = this.runtime
      .execute({
        runId: run.id,
        taskId: task.id,
        nodeId: task.node_id,
        attempt,
        repoPath: run.repo_path,
        baseCommit: run.base_commit,
        adapter: task.adapter,
        profile: implementer,
        instructions: buildInstructions(implementer, run.prompt),
        ...(run.model ? { model: run.model } : {}),
        tools: this.policy.taskGrant(run.allow_commands),
        budget: {
          maxCost: Math.max(run.budget - run.cost_total, 0),
          maxTurns: 0,
          timeoutMs: this.config.scheduler.task_timeout_minutes * 60_000,
        },
        ...(task.resume_token ? { resumeToken: task.resume_token } : {}),
        ...(task.sandbox_id ? { sandboxId: task.sandbox_id } : {}),
      })
      .then(
        (outcome) => this.finish(task, attempt, outcome),
        (err: unknown) =>
          this.finish(task, attempt, {
            status: "failed",
            summary: "",
            artifacts: [],
            claims: [],
            usage: [],
            error: { kind: "fatal", message: err instanceof Error ? err.message : String(err) },
            cost: 0,
            durationMs: 0,
          }),
      )
      .catch(() => {
        // finish() only fails if the store is closed during shutdown.
      })
      .finally(() => {
        this.active.delete(task.id);
        this.cancelRequested.delete(task.id);
        this.pump();
      });
    this.active.set(task.id, work);
  }

  private finish(task: TaskRecord, attempt: number, outcome: TaskOutcome): void {
    // A stopping daemon leaves the task `running`; recovery on the next start requeues it.
    if (this.stopping) return;
    const runId = task.run_id;
    const cancelled = this.cancelRequested.has(task.id) || outcome.error?.kind === "cancelled";
    const events: NewEvent[] = [
      {
        type: "task.completed",
        run_id: runId,
        task_id: task.id,
        actor: { kind: "agent", profile: task.profile, adapter: task.adapter },
        payload: {
          status: outcome.status,
          summary: outcome.summary,
          artifacts: outcome.artifacts,
          cost: outcome.cost,
          duration_ms: outcome.durationMs,
          ...(outcome.error ? { error: outcome.error } : {}),
        },
      },
    ];

    const run = this.store.getRun(runId)!;
    if (cancelled) {
      events.push(taskStatus(runId, task.id, "running", "cancelled", attempt, "cancelled by user"));
      if (!isTerminalRun(run.status)) events.push(runStatus(runId, run.status, "cancelled", "cancelled by user"));
    } else if (outcome.status === "succeeded") {
      events.push(taskStatus(runId, task.id, "running", "succeeded", attempt));
      const others = this.store.tasksOfRun(runId).filter((t) => t.id !== task.id);
      if (others.every((t) => t.status === "succeeded") && !isTerminalRun(run.status)) {
        events.push(runStatus(runId, run.status, "done", "all tasks succeeded"));
      }
    } else {
      const kind = outcome.error?.kind ?? "fatal";
      const error = outcome.error ?? { kind, message: outcome.summary || "task failed" };
      events.push(taskStatus(runId, task.id, "running", "failed", attempt, error.message, error));
      if (RETRYABLE.has(kind) && attempt < task.max_attempts && !isTerminalRun(run.status)) {
        events.push(taskStatus(runId, task.id, "failed", "ready", attempt, `retry after ${kind}`));
      } else if (!isTerminalRun(run.status)) {
        const to = kind === "budget_exceeded" ? "budget_exceeded" : "failed";
        events.push(runStatus(runId, run.status, to, error.message));
      }
    }
    this.store.append(events);
  }
}
