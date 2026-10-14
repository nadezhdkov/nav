import type { AgentRuntime, TaskOutcome } from "@vectr/agent-runtime";
import { canTransitionRun, isTerminalRun, newId, type Actor, type NewEvent, type RunStatus } from "@vectr/contracts";
import type { Config } from "../config.ts";
import type { EventStore, RunRecord, TaskRecord } from "../events/store.ts";
import { runStatus, taskStatus } from "../orchestrator/orchestrator.ts";
import { buildInstructions, implementer } from "../orchestrator/profiles.ts";
import type { PolicyEngine } from "../policy/engine.ts";

const RETRYABLE = new Set(["transient", "interrupted"]);
/** Margin after a provider's reset time, for clock skew. */
const RESET_MARGIN_MS = 5_000;
const scheduler: Actor = { kind: "system", component: "scheduler" };

/** Ready tasks in dispatch order: already-attempted tasks first, FIFO within each group. */
function dispatchOrder(tasks: TaskRecord[]): TaskRecord[] {
  const started = tasks.filter((t) => t.attempt > 0);
  return [...started, ...tasks.filter((t) => t.attempt === 0)];
}

export type CancelHook = (taskId: string) => Promise<void>;

/** Runs a non-agent node of a run (verify, open_pr) in place of the Agent Runtime. */
export type ActionExecutor = {
  /** The side effect this node performs, decided by the Policy Engine before dispatch. */
  action: string;
  /** What will happen, for whoever approves it. */
  describe(run: RunRecord, task: TaskRecord): string;
  execute(ctx: { run: RunRecord; task: TaskRecord; attempt: number; signal: AbortSignal }): Promise<TaskOutcome>;
};

/** The run state while a node is in progress (spec §8.4), and the one it leaves when that node succeeds. */
const NODE_RUN_STATUS: Record<string, RunStatus> = { implement: "executing", verify: "verifying", open_pr: "ready_for_pr" };
const NODE_DONE_STATUS: Record<string, RunStatus> = { open_pr: "pr_opened" };

/**
 * Scheduler (spec §6.1.2): picks `ready` tasks, asks the Policy Engine, dispatches them to the
 * Agent Runtime within the concurrency limit, and records the outcome. Phase 0: one global
 * limit, FIFO order except that tasks already attempted (interrupted or retried, often with a
 * live agent conversation) go first, immediate retry for transient errors. A rate-limited task waits for its
 * quota to reset (`not_before`), or the run is paused when the reset is too far away (ADR 0005).
 */
export class Scheduler {
  private readonly store: EventStore;
  private readonly runtime: AgentRuntime;
  private readonly policy: PolicyEngine;
  private readonly config: Config;
  private readonly cancelHook: CancelHook;
  private readonly actions: Map<string, ActionExecutor>;
  private readonly active = new Map<string, Promise<void>>();
  private readonly cancelRequested = new Set<string>();
  /** One per active task; aborting ends its setup or agent whatever stage it is in. */
  private readonly aborts = new Map<string, AbortController>();
  private stopping = false;
  private pumping = false;
  private wakeTimer: NodeJS.Timeout | undefined;
  private wakeAt = Infinity;

  constructor(deps: {
    store: EventStore;
    runtime: AgentRuntime;
    policy: PolicyEngine;
    config: Config;
    cancel: CancelHook;
    actions?: Map<string, ActionExecutor>;
  }) {
    this.actions = deps.actions ?? new Map();
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
    const now = Date.now();
    let nextWake = Infinity;
    try {
      for (const task of dispatchOrder(this.store.tasksWithStatus("ready"))) {
        if (this.active.has(task.id)) continue;
        const notBefore = task.not_before ? Date.parse(task.not_before) : 0;
        if (notBefore > now) {
          nextWake = Math.min(nextWake, notBefore);
          continue;
        }
        if (this.active.size >= this.config.scheduler.concurrency) break;
        this.dispatch(task);
      }
    } finally {
      this.pumping = false;
    }
    this.wakeUpAt(nextWake);
  }

  /** Pumps again when the earliest waiting task becomes due. */
  private wakeUpAt(at: number): void {
    if (at === this.wakeAt) return;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.wakeAt = at;
    if (!Number.isFinite(at)) return;
    // setTimeout caps at ~24.8 days; a longer wait just re-arms on that wake-up.
    const delay = Math.min(Math.max(at - Date.now(), 0), 2 ** 31 - 1);
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.wakeAt = Infinity;
      this.pump();
    }, delay);
    this.wakeTimer.unref();
  }

  requestCancel(taskId: string): void {
    this.cancelRequested.add(taskId);
    this.aborts.get(taskId)?.abort();
    void this.cancelHook(taskId);
  }

  /** Stops dispatching and waits for running tasks to end without recording their results. */
  async stop(killAll: () => Promise<void>): Promise<void> {
    this.stopping = true;
    clearTimeout(this.wakeTimer);
    for (const abort of this.aborts.values()) abort.abort();
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

    const executor = task.type === "agent" ? undefined : this.actions.get(task.node_id);
    if (task.type !== "agent" && !executor) {
      this.store.append([taskStatus(run.id, task.id, "ready", "blocked", task.attempt, `no executor for node ${task.node_id}`)]);
      return;
    }
    const action = executor?.action ?? "task.start";
    const decision = this.policy.decide(scheduler, action, task.id, {
      autonomyLevel: this.config.autonomy_level,
      budgetRemaining: run.budget - run.cost_total,
    });
    const nodeStatus = NODE_RUN_STATUS[task.node_id];
    if (decision.effect === "require_approval" && executor && !this.store.taskApproved(task.id)) {
      const events: NewEvent[] = [
        taskStatus(run.id, task.id, "ready", "waiting_approval", task.attempt, decision.reason),
        {
          type: "approval.requested",
          run_id: run.id,
          task_id: task.id,
          actor: scheduler,
          payload: { approval_id: newId("apr"), action, resource: task.id, reason: decision.reason, summary: executor.describe(run, task) },
        },
      ];
      if (nodeStatus && canTransitionRun(run.status, nodeStatus)) events.push(runStatus(run.id, run.status, nodeStatus, "waiting for approval"));
      this.store.append(events);
      return;
    }
    if (decision.effect === "deny" || (decision.effect === "require_approval" && !executor)) {
      this.store.append([
        {
          type: "policy.denied",
          run_id: run.id,
          task_id: task.id,
          actor: scheduler,
          payload: { action, resource: task.id, reason: decision.reason },
        },
        taskStatus(run.id, task.id, "ready", "blocked", task.attempt, decision.reason),
      ]);
      return;
    }

    const attempt = task.attempt + 1;
    const events: NewEvent[] = [taskStatus(run.id, task.id, "ready", "running", attempt)];
    const to = nodeStatus ?? "executing";
    if (canTransitionRun(run.status, to) && run.status !== "paused") events.push(runStatus(run.id, run.status, to, `${task.node_id} dispatched`));
    this.store.append(events);

    const tools = this.policy.taskGrant(run.allow_commands);
    const abort = new AbortController();
    this.aborts.set(task.id, abort);
    const execution = executor
      ? executor.execute({ run, task, attempt, signal: abort.signal })
      : this.runtime.execute({
        runId: run.id,
        taskId: task.id,
        nodeId: task.node_id,
        attempt,
        repoPath: run.repo_path,
        baseCommit: run.base_commit,
        adapter: task.adapter,
        profile: implementer,
        instructions: buildInstructions(implementer, run.prompt, tools),
        ...(run.model ? { model: run.model } : {}),
        tools,
        setupCommands: run.setup_commands,
        budget: {
          maxCost: Math.max(run.budget - run.cost_total, 0),
          maxTurns: 0,
          timeoutMs: this.config.scheduler.task_timeout_minutes * 60_000,
        },
        ...(task.resume_token ? { resumeToken: task.resume_token } : {}),
        ...(task.sandbox_id ? { sandboxId: task.sandbox_id } : {}),
        signal: abort.signal,
      });
    const work = execution
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
        this.aborts.delete(task.id);
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
        actor: task.type === "agent" ? { kind: "agent", profile: task.profile, adapter: task.adapter } : { kind: "system", component: task.adapter },
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
      // Phase 1 runs are a fixed chain (implement → verify → open_pr); slice 2's Flow engine replaces this.
      const next = this.store.tasksOfRun(runId).find((t) => t.status === "pending");
      if (!isTerminalRun(run.status)) {
        let from = run.status;
        const reached = NODE_DONE_STATUS[task.node_id];
        if (reached && canTransitionRun(from, reached)) {
          events.push(runStatus(runId, from, reached, `${task.node_id} succeeded`));
          from = reached;
        }
        if (next) events.push(taskStatus(runId, next.id, "pending", "ready", 0, `${task.node_id} succeeded`));
        else events.push(runStatus(runId, from, "done", "all tasks succeeded"));
      }
    } else {
      const kind = outcome.error?.kind ?? "fatal";
      const error = outcome.error ?? { kind, message: outcome.summary || "task failed" };
      events.push(taskStatus(runId, task.id, "running", "failed", attempt, error.message, error));
      // Waits for a quota reset are not counted as attempts.
      const attempts = attempt - task.rate_limit_waits;
      if (kind === "rate_limited" && !isTerminalRun(run.status)) {
        events.push(...this.waitForQuota(task, attempt, run.status, error.retry_at));
      } else if (RETRYABLE.has(kind) && attempts < task.max_attempts && !isTerminalRun(run.status)) {
        events.push(taskStatus(runId, task.id, "failed", "ready", attempt, `retry after ${kind}`));
      } else if (!isTerminalRun(run.status)) {
        const to = kind === "budget_exceeded" ? "budget_exceeded" : "failed";
        events.push(runStatus(runId, run.status, to, error.message));
      }
    }
    this.store.append(events);
  }

  /**
   * A rate-limited task goes back to `ready` with `not_before` set to the provider's reset time
   * (or the next backoff step when it did not say). A reset beyond the automatic limit, or too
   * many waits, pauses the run instead; `vectr run resume` continues it.
   */
  private waitForQuota(task: TaskRecord, attempt: number, runState: RunStatus, retryAt: string | undefined): NewEvent[] {
    const cfg = this.config.scheduler;
    const now = Date.now();
    const backoff = cfg.rate_limit_backoff_minutes;
    const reset = retryAt ? Date.parse(retryAt) : NaN;
    const until = Number.isFinite(reset)
      ? Math.max(reset + RESET_MARGIN_MS, now)
      : now + backoff[Math.min(task.rate_limit_waits, backoff.length - 1)]! * 60_000;
    const untilIso = new Date(until).toISOString();
    const tooFar = until - now > cfg.rate_limit_max_wait_hours * 3_600_000;
    if (task.rate_limit_waits >= cfg.rate_limit_max_waits || tooFar) {
      const why = tooFar ? `${task.adapter} quota resets at ${untilIso}` : `${task.adapter} still rate limited after ${task.rate_limit_waits} waits`;
      return [runStatus(task.run_id, runState, "paused", `${why}; continue with \`vectr run resume ${task.run_id}\``)];
    }
    const reason = `waiting for ${task.adapter} quota until ${untilIso}`;
    return [taskStatus(task.run_id, task.id, "failed", "ready", attempt, reason, undefined, untilIso)];
  }
}
