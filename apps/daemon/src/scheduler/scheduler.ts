import type { AgentRuntime, TaskOutcome } from "@navarch/agent-runtime";
import { compileContext } from "@navarch/knowledge";
import { canTransitionRun, INSTRUCTION_INTERRUPT, isTerminalRun, PAUSE_INTERRUPT, newId, type Actor, type BudgetView, type CompiledContext, type NewEvent, type RunStatus } from "@navarch/contracts";
import { Budgets } from "../budgets/budgets.ts";
import { observedFor } from "../budgets/metrics.ts";
import type { Config } from "../config.ts";
import type { EventStore, RunRecord, TaskRecord } from "../events/store.ts";
import { runStatus, taskStatus } from "../orchestrator/orchestrator.ts";
import { buildInstructions, implementer, leadTurnPrompt, parseComplexity, PROFILES, resumeWithInstructions, type Profile } from "../orchestrator/profiles.ts";
import { ownsWorktree, ownWorktreeKey } from "../orchestrator/worktrees.ts";
import type { PolicyEngine } from "../policy/engine.ts";

const RETRYABLE = new Set(["transient", "interrupted"]);
/** Margin after a provider's reset time, for clock skew. */
const RESET_MARGIN_MS = 5_000;
/** The smallest cap a billed agent starts with; below it the agent waits for running ones (ADR 0030). */
const MIN_SHARE = 0.01;
/** Profiles whose prompt carries the compiled context (ADR 0043). */
const CONTEXT_PROFILES: ReadonlySet<string> = new Set(["triager", "planner", "implementer", "researcher", "lead"]);

const scheduler: Actor = { kind: "system", component: "scheduler" };

/** Ready tasks in dispatch order: already-attempted tasks first, FIFO within each group. */
function dispatchOrder(tasks: TaskRecord[]): TaskRecord[] {
  const started = tasks.filter((t) => t.attempt > 0);
  return [...started, ...tasks.filter((t) => t.attempt === 0)];
}

export type CancelHook = (taskId: string) => Promise<void>;

/** Runs a non-agent node of a run (verification, PR, approval) in place of the Agent Runtime. */
export type ActionExecutor = {
  /** The side effect this node performs, decided by the Policy Engine before dispatch. */
  action: string;
  /** What will happen, for whoever approves it. */
  describe(run: RunRecord, task: TaskRecord): string;
  execute(ctx: { run: RunRecord; task: TaskRecord; attempt: number; signal: AbortSignal }): Promise<TaskOutcome>;
};

/** How far back observed metrics reach for routing (ADR 0023). */
const OBSERVED_WINDOW_MS = 30 * 86_400_000;

/** Runs created before Flows carry no stage on their tasks. */
const LEGACY_STAGE: Record<string, RunStatus> = { implement: "executing", verify: "verifying", open_pr: "ready_for_pr" };
/** Executors of legacy tasks, which had no `uses`. */
const LEGACY_USES: Record<string, string> = { verify: "verification.run", open_pr: "pr.create" };

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
  private readonly budgets: Budgets;
  private readonly cancelHook: CancelHook;
  private readonly actions: Map<string, ActionExecutor>;
  private readonly onSucceeded: (runId: string) => void;
  private readonly billingOf: (adapter: string) => "metered" | "plan";
  private readonly active = new Map<string, Promise<void>>();
  private readonly cancelRequested = new Set<string>();
  private readonly stopRequested = new Map<string, string>();
  /** Running tasks the user interrupted, with why: an instruction (ADR 0019) or a pause (ADR 0020). */
  private readonly interruptRequested = new Map<string, string>();
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
    budgets?: Budgets;
    actions?: Map<string, ActionExecutor>;
    /** Called after a task succeeded, to advance the run's TaskGraph (the Orchestrator). */
    onSucceeded?: (runId: string) => void;
    /** How an adapter declares its use is paid for (ADR 0023); unknown adapters count as billed. */
    billingOf?: (adapter: string) => "metered" | "plan";
  }) {
    this.billingOf = deps.billingOf ?? (() => "metered");
    this.actions = deps.actions ?? new Map();
    this.onSucceeded = deps.onSucceeded ?? (() => {});
    this.store = deps.store;
    this.runtime = deps.runtime;
    this.policy = deps.policy;
    this.config = deps.config;
    this.budgets = deps.budgets ?? new Budgets({ store: deps.store, config: deps.config });
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

  /**
   * Stops a running task that its Flow no longer needs (a parallel branch after its join, ADR 0036):
   * the task ends `cancelled` and the run goes on.
   */
  requestStop(taskId: string, reason: string): boolean {
    if (!this.active.has(taskId) || this.stopRequested.has(taskId)) return false;
    this.stopRequested.set(taskId, reason);
    this.aborts.get(taskId)?.abort();
    void this.cancelHook(taskId);
    return true;
  }

  requestCancel(taskId: string): void {
    this.cancelRequested.add(taskId);
    this.aborts.get(taskId)?.abort();
    void this.cancelHook(taskId);
  }

  /**
   * Stops a running agent so it resumes with the user's pending instructions (ADR 0019). The
   * attempt ends as `interrupted` and goes back to `ready` without counting as an attempt.
   */
  requestInterrupt(taskId: string, reason: string = INSTRUCTION_INTERRUPT): boolean {
    if (!this.active.has(taskId)) return false;
    this.interruptRequested.set(taskId, reason);
    this.aborts.get(taskId)?.abort();
    void this.cancelHook(taskId);
    return true;
  }

  /** Stops dispatching and waits for running tasks to end without recording their results. */
  async stop(killAll: () => Promise<void>): Promise<void> {
    this.stopping = true;
    clearTimeout(this.wakeTimer);
    for (const abort of this.aborts.values()) abort.abort();
    await killAll();
    await Promise.allSettled([...this.active.values()]);
  }

  /** Resolves once no task is running (used by tests and `navarch daemon stop`). */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active.values()]);
  }

  /**
   * The compiled context block of an agent task (ADR 0043), recorded as `context.compiled`. It never
   * fails the task: any problem means the agent runs without the block.
   */
  private async compileContext(run: RunRecord, task: TaskRecord, profile: Profile, attempt: number): Promise<CompiledContext | undefined> {
    const cfg = this.config.knowledge.context;
    if (!cfg.enabled || !CONTEXT_PROFILES.has(profile.id)) return undefined;
    try {
      const context = await compileContext({ root: run.repo_path, task: run.prompt, maxTokens: cfg.max_tokens });
      if (!context) return undefined;
      this.store.append([
        {
          type: "context.compiled",
          run_id: run.id,
          task_id: task.id,
          actor: scheduler,
          payload: { chars: context.chars, est_tokens: context.est_tokens, max_tokens: context.max_tokens, sources: context.sources.slice(0, 50), ms: context.ms, attempt },
        },
      ]);
      return context;
    } catch {
      return undefined;
    }
  }

  private dispatch(queued: TaskRecord): void {
    const run = this.store.getRunRecord(queued.run_id);
    // A paused run keeps its ready tasks until it is resumed (ADR 0020).
    if (!run || run.status === "paused") return;
    let task = queued;
    if (task.type === "agent" && task.routing === "auto" && !task.model_id) {
      this.store.append([this.routeTask(run, task)]);
      task = this.store.getTask(task.id)!;
    }

    const uses = task.type === "approval" ? "approval" : (task.uses ?? LEGACY_USES[task.node_id]);
    const executor = task.type === "agent" ? undefined : uses ? this.actions.get(uses) : undefined;
    if (task.type !== "agent" && !executor) {
      this.store.append([taskStatus(run.id, task.id, "ready", "blocked", task.attempt, `no executor for node ${task.node_id}`)]);
      return;
    }
    const profile = task.type === "agent" ? (PROFILES.get(task.profile) ?? implementer) : undefined;
    // A conflict's resolver is delegated like a member (ADR 0029).
    const delegated = task.team?.role === "member" || task.team?.role === "integrate";
    const runAction = executor?.action ?? (task.team?.role === "lead" ? "team.turn" : delegated ? "team.delegate" : "task.start");
    // A used-up budget (run, project day or global month) asks a human before any agent starts (ADR 0023).
    const exceeded = executor ? [] : this.budgets.scopesOf(run).filter((s) => s.state === "exceeded");
    const overBudget = exceeded.length > 0 && !this.store.taskApproved(task.id, "budget.exceed");
    const action = overBudget ? "budget.exceed" : runAction;
    // Billed agents running at once share what is left (ADR 0030): this one gets an equal part of
    // what the running ones do not hold, and waits, still ready, while they hold all of it.
    const billed = !executor && !overBudget && this.billed(task.adapter);
    let budgetRemaining = this.budgets.remaining(run);
    if (billed) {
      const available = this.budgets.available(run);
      if (Number.isFinite(available)) {
        const share = Math.floor((available / (1 + this.billedPeers(run, task))) * 100) / 100;
        if (share < MIN_SHARE && this.budgets.heldFor(run)) return;
        budgetRemaining = Math.min(budgetRemaining, Math.max(share, MIN_SHARE));
      }
    }
    const decision = this.policy.decide(scheduler, action, task.id, {
      autonomyLevel: run.autonomy_level ?? this.config.autonomy_level,
      budgetRemaining,
      ...(overBudget ? { budgetExceeded: exceeded.map(describeBudget) } : {}),
      ...(profile ? { edits: profile.edits } : {}),
    });
    const nodeStatus = task.stage ?? LEGACY_STAGE[task.node_id];
    const agentText = `Run the ${task.profile} agent (${task.adapter}) on this run's worktree${profile?.edits ? ", editing files" : ", read-only"}.`;
    const describe = executor
      ? executor.describe(run, task)
      : overBudget
        ? `${agentText} Over budget: ${exceeded.map(describeBudget).join("; ")}. Approving lets this one task spend beyond it; raising the budget releases every waiting task.`
        : agentText;
    if (decision.effect === "require_approval" && !this.store.taskApproved(task.id, action)) {
      const events: NewEvent[] = [
        taskStatus(run.id, task.id, "ready", "waiting_approval", task.attempt, decision.reason),
        {
          type: "approval.requested",
          run_id: run.id,
          task_id: task.id,
          actor: scheduler,
          payload: { approval_id: newId("apr"), action, resource: task.id, reason: decision.reason, summary: describe, ...(task.choices?.length ? { choices: task.choices } : {}) },
        },
      ];
      // An approval node puts the run in awaiting_approval; a budget stop shows as budget_exceeded;
      // a gated side effect keeps the stage it belongs to.
      const waitStatus = task.type === "approval" ? "awaiting_approval" : overBudget ? "budget_exceeded" : nodeStatus;
      if (waitStatus && canTransitionRun(run.status, waitStatus)) events.push(runStatus(run.id, run.status, waitStatus, "waiting for approval"));
      this.store.append(events);
      return;
    }
    if (decision.effect === "deny") {
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
    if (canTransitionRun(run.status, to)) events.push(runStatus(run.id, run.status, to, `${task.node_id} dispatched`));
    // The user's instructions go to the next agent attempt of the run (or of the task they name).
    const messages = executor ? [] : this.store.pendingMessagesFor(task);
    for (const m of messages) {
      events.push({
        type: "run.message.delivered",
        run_id: run.id,
        task_id: task.id,
        actor: scheduler,
        payload: { message_id: m.id, task_id: task.id, attempt },
      });
    }
    this.store.append(events);
    const texts = messages.map((m) => m.text);

    const tools = this.policy.taskGrant(run.allow_commands, profile?.edits ?? true);
    const previousLead = this.previousLeadTurn(task);
    const leadSession = previousLead?.adapter === task.adapter ? (previousLead.resume_token ?? undefined) : undefined;
    const runSlug = run.flow_definition?.definition.metadata.name;
    // A parallel team member or a competitor works in its own worktree, forked from the run's (ADR 0029, 0031).
    const ownKey = ownWorktreeKey(task);
    const own = runSlug && ownKey ? ownKey : undefined;
    const sandboxSlug = own ? `${runSlug}-${own}` : runSlug;
    const runSandboxId = runSlug && !own ? this.store.taskRecordsOfRun(run.id).find((t) => t.sandbox_id && !ownsWorktree(t))?.sandbox_id : undefined;
    const sandboxId = task.sandbox_id ?? runSandboxId;
    const abort = new AbortController();
    this.aborts.set(task.id, abort);
    if (billed) this.budgets.reserve(run, task.id, budgetRemaining);
    const execution = executor
      ? executor.execute({ run, task, attempt, signal: abort.signal })
      : this.compileContext(run, task, profile!, attempt).then((context) => this.runtime.execute({
        runId: run.id,
        taskId: task.id,
        nodeId: task.node_id,
        attempt,
        repoPath: run.repo_path,
        baseCommit: run.base_commit,
        adapter: task.adapter,
        ...(sandboxSlug ? { sandboxSlug } : {}),
        ...(own ? { forkFrom: runSlug } : {}),
        profile: profile!,
        instructions: buildInstructions(profile!, run.prompt, tools, task.inputs, texts, this.store.runAttachments(run.id), context),
        ...(task.model ? { model: task.model } : {}),
        tools,
        // Setup prepares the worktree for editing agents; read-only agents only read it.
        setupCommands: profile!.edits ? run.setup_commands : [],
        ...(run.isolation ? { container: { runtime: this.config.container.runtime, isolation: run.isolation } } : {}),
        ...(profile!.id === "planner" ? { summaryArtifact: "plan" as const } : {}),
        budget: {
          // Billed agents stop at the smallest amount left (0: no limit, or approved beyond it).
          maxCost: Number.isFinite(budgetRemaining) ? budgetRemaining : 0,
          maxTurns: 0,
          timeoutMs: this.config.scheduler.task_timeout_minutes * 60_000,
        },
        ...(task.resume_token ? { resumeToken: task.resume_token } : {}),
        ...(task.resume_token && texts.length ? { resumePrompt: resumeWithInstructions(texts) } : {}),
        // A lead's next turn continues its own session with only what changed (ADR 0022).
        ...(!task.resume_token && leadSession ? { resumeToken: leadSession, resumePrompt: leadTurnPrompt(task.inputs, texts) } : {}),
        ...(sandboxId ? { sandboxId } : {}),
        signal: abort.signal,
      }));
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
        this.budgets.release(task.id);
        this.active.delete(task.id);
        this.aborts.delete(task.id);
        this.cancelRequested.delete(task.id);
        this.interruptRequested.delete(task.id);
        this.pump();
      });
    this.active.set(task.id, work);
  }

  /** Whether an agent's use is expected to be billed: its adapter says so, or its latest use was. */
  private billed(adapter: string): boolean {
    return (this.store.lastBillingOf(adapter) ?? this.billingOf(adapter)) === "metered";
  }

  /** Other billed agent tasks ready to start that count towards one of this run's limited budgets. */
  private billedPeers(run: RunRecord, task: TaskRecord): number {
    const keys = new Set(this.budgets.limitedScopes(run));
    const runs = new Map<string, boolean>();
    return this.store.tasksWithStatus("ready").filter((t) => {
      if (t.id === task.id || t.type !== "agent" || this.active.has(t.id) || !this.billed(t.adapter)) return false;
      if (!runs.has(t.run_id)) {
        const other = this.store.getRunRecord(t.run_id);
        runs.set(t.run_id, !!other && this.budgets.limitedScopes(other).some((k) => keys.has(k)));
      }
      return runs.get(t.run_id)!;
    }).length;
  }

  private finish(task: TaskRecord, attempt: number, outcome: TaskOutcome): void {
    // A stopping daemon leaves the task `running`; recovery on the next start requeues it.
    if (this.stopping) return;
    const runId = task.run_id;
    const interruptReason = this.interruptRequested.get(task.id);
    const interrupted = interruptReason !== undefined;
    // An interrupted attempt ends like a cancelled one; only a cancel request cancels the run.
    const cancelled = this.cancelRequested.has(task.id) || (outcome.error?.kind === "cancelled" && !interrupted);
    const complexity = task.profile === "triager" && outcome.status === "succeeded" ? parseComplexity(outcome.summary) : undefined;
    const outputs = complexity === undefined ? outcome.outputs : { ...outcome.outputs, complexity };
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
          ...(outputs ? { outputs } : {}),
        },
      },
    ];

    const run = this.store.getRun(runId)!;
    const stopReason = this.stopRequested.get(task.id);
    if (stopReason !== undefined) {
      this.stopRequested.delete(task.id);
      if (!this.cancelRequested.has(task.id) && !isTerminalRun(run.status)) {
        events.push(taskStatus(runId, task.id, "running", "cancelled", attempt, stopReason));
        this.store.append(events);
        this.onSucceeded(runId);
        return;
      }
    }
    if (!cancelled && interrupted && !isTerminalRun(run.status)) {
      events.push(
        taskStatus(runId, task.id, "running", "interrupted", attempt, interruptReason, {
          kind: "interrupted",
          message: interruptReason === PAUSE_INTERRUPT ? "stopped because the user paused the run" : "stopped by the user to give an instruction",
        }),
        taskStatus(runId, task.id, "interrupted", "ready", attempt, interruptReason),
      );
      this.store.append(events);
      return;
    }
    if (cancelled) {
      events.push(taskStatus(runId, task.id, "running", "cancelled", attempt, "cancelled by user"));
      if (!isTerminalRun(run.status)) events.push(runStatus(runId, run.status, "cancelled", "cancelled by user"));
    } else if (outcome.status === "succeeded") {
      events.push(taskStatus(runId, task.id, "running", "succeeded", attempt));
      this.store.append(events);
      this.onSucceeded(runId);
      return;
    } else {
      const kind = outcome.error?.kind ?? "fatal";
      const error = outcome.error ?? { kind, message: outcome.summary || "task failed" };
      events.push(taskStatus(runId, task.id, "running", "failed", attempt, error.message, error));
      // Waits for a quota reset and interruptions by the user are not counted as attempts.
      const attempts = attempt - task.rate_limit_waits - task.instruction_interrupts;
      if (kind === "rate_limited" && task.type === "agent") events.push(this.rateLimitObserved(task, error.retry_at));
      const fallback = kind === "rate_limited" && !isTerminalRun(run.status) ? this.fallback(task) : undefined;
      if (fallback) {
        // Another agent takes over right away; like a quota wait, this is not an attempt.
        events.push(fallback, taskStatus(runId, task.id, "failed", "ready", attempt, `rate limited; falling back to ${fallback.payload.adapter}`, undefined, new Date().toISOString()));
      } else if (kind === "rate_limited" && !isTerminalRun(run.status)) {
        events.push(...this.waitForQuota(task, attempt, run.status, error.retry_at));
      } else if (RETRYABLE.has(kind) && attempts < task.max_attempts && !isTerminalRun(run.status)) {
        events.push(taskStatus(runId, task.id, "failed", "ready", attempt, `retry after ${kind}`));
      } else if (flowDecidesFailure(task) && kind !== "budget_exceeded" && !isTerminalRun(run.status)) {
        // A member that failed does not fail the team: its lead reads the failure next turn (ADR 0022),
        // nor does a failed merge of a parallel member (ADR 0029), a competitor whose agent failed
        // (it is out, ADR 0031) or a parallel branch (its join decides, ADR 0036).
        this.store.append(events);
        this.onSucceeded(runId);
        return;
      } else if (!isTerminalRun(run.status)) {
        const to = kind === "budget_exceeded" ? "budget_exceeded" : "failed";
        events.push(runStatus(runId, run.status, to, error.message));
      }
    }
    this.store.append(events);
  }

  /**
   * Asks the Model Router, through the Agent Runtime, where an agent task runs (ADR 0013). When
   * no candidate is usable the task keeps the run's adapter, which then waits for its quota.
   */
  private routeTask(run: RunRecord, task: TaskRecord, exclude: string[] = []): NewEvent<"model.routed"> {
    const tasks = this.store.taskRecordsOfRun(run.id);
    // A lead's later turns prefer the agent of its previous turn, so it can resume that session (ADR 0022);
    // a competitor's fix iterations stay with its agent, and its first one avoids the others' (ADR 0031).
    const competitor = task.compete?.role === "competitor" ? task.compete : undefined;
    const rivals = competitor ? tasks.filter((t) => t.compete?.role === "competitor" && t.compete.node_id === competitor.node_id && t.compete.key !== competitor.key && t.model_id) : [];
    const earlier = competitor ? tasks.filter((t) => t.node_id === task.node_id && t.iteration < task.iteration && t.model_id).at(-1) : undefined;
    const prefer = task.prefer ?? this.previousLeadTurn(task)?.model_id ?? earlier?.model_id ?? undefined;
    const triage = tasks.filter((t) => t.profile === "triager" && t.status === "succeeded").at(-1);
    const complexity = typeof triage?.outputs?.complexity === "number" ? triage.outputs.complexity : undefined;
    const implementerProviders = [
      ...new Set(tasks.filter((t) => t.profile === "implementer" && t.status === "succeeded").map((t) => this.providerOf(t))),
    ];
    // Budget left, quota headroom and observed failures and costs adjust the order (ADR 0023).
    const now = Date.now();
    const observed = observedFor(this.store.attemptsSince(new Date(now - OBSERVED_WINDOW_MS).toISOString()), now);
    const quotaUse = this.store
      .quotas(now)
      .filter((q) => !q.exhausted && q.utilization !== null && (!q.resets_at || Date.parse(q.resets_at) > now))
      .map((q) => ({
        adapter: q.adapter,
        window: q.window,
        utilization: q.utilization!,
        ...(q.model_prefix ? { modelPrefix: q.model_prefix } : {}),
        ...(q.resets_at ? { resetsAt: q.resets_at } : {}),
      }));
    const decision = this.runtime.route({
      profile: task.profile,
      ...(complexity !== undefined ? { complexity } : {}),
      iteration: task.iteration,
      implementerProviders,
      exhausted: this.store.exhaustedQuotas(),
      exclude,
      ...(prefer ? { prefer } : {}),
      ...(earlier && prefer === earlier.model_id ? { preferredBy: "this competitor's earlier iteration" } : {}),
      ...(rivals.length ? { spread: [...new Set(rivals.map((t) => t.model_id!))] } : {}),
      // What running billed agents hold is not there to spend (ADR 0030).
      budgetRemaining: this.budgets.available(run),
      quotaUse,
      observed: (id) => observed(id, task.profile),
    });
    const chosen: { id: string; adapter: string; model?: string; provider: string } = decision?.chosen ?? {
      id: task.model_id ?? task.adapter,
      adapter: task.adapter,
      ...(task.model ? { model: task.model } : {}),
      provider: this.providerOf(task),
    };
    return {
      type: "model.routed",
      run_id: run.id,
      task_id: task.id,
      actor: { kind: "system", component: "model-router" },
      payload: {
        model_id: chosen.id,
        adapter: chosen.adapter,
        ...(chosen.model ? { model: chosen.model } : {}),
        provider: chosen.provider,
        tier: decision?.tier ?? "standard",
        reason: decision?.chosen ? decision.reason : `${decision?.reason ?? "routing is off"}; keeping the run's adapter`,
        candidates: decision?.candidates ?? [],
        skipped: decision?.skipped ?? [],
        ...(exclude.length ? { fallback_from: exclude.at(-1)! } : {}),
      },
    };
  }

  /**
   * The lead's latest earlier turn that holds its session, for a lead turn after the first. A
   * resumed turn continues the same session and records no token of its own.
   */
  private previousLeadTurn(task: TaskRecord): TaskRecord | undefined {
    if (task.team?.role !== "lead" || task.iteration < 2) return undefined;
    return this.store
      .taskRecordsOfRun(task.run_id)
      .filter((t) => t.node_id === task.node_id && t.iteration < task.iteration && t.resume_token)
      .sort((a, b) => b.iteration - a.iteration)[0];
  }

  /** On a rate limit, the next usable candidate other than those this task already left (spec §6.4.2 step 5). */
  private fallback(task: TaskRecord): NewEvent<"model.routed"> | undefined {
    if (task.type !== "agent" || task.routing !== "auto") return undefined;
    const run = this.store.getRunRecord(task.run_id);
    if (!run) return undefined;
    const left = [...this.store.routedFrom(task.id), task.model_id ?? task.adapter];
    const routed = this.routeTask(run, task, left);
    return left.includes(routed.payload.model_id) ? undefined : routed;
  }

  /**
   * Records a rate limit as an exhausted quota window until the reset the agent reported, or for
   * `routing.rate_limit_cooldown_minutes` when it gave none, so the Model Router skips the agent
   * meanwhile instead of trying it first on every task (go/no-go finding F4).
   */
  private rateLimitObserved(task: TaskRecord, retryAt: string | undefined): NewEvent<"quota.observed"> {
    const now = Date.now();
    const reset = retryAt ? Date.parse(retryAt) : NaN;
    const until = Number.isFinite(reset) ? Math.max(reset, now) : now + this.config.routing.rate_limit_cooldown_minutes * 60_000;
    // A native model's limit belongs to its provider, not to every native model (ADR 0014).
    const prefix = task.adapter === "native" && task.model?.includes("/") ? `${task.model.split("/")[0]}/` : undefined;
    return {
      type: "quota.observed",
      run_id: task.run_id,
      task_id: task.id,
      actor: scheduler,
      payload: { adapter: task.adapter, window: "rate_limit", exhausted: true, resets_at: new Date(until).toISOString(), ...(prefix ? { model_prefix: prefix } : {}) },
    };
  }

  private providerOf(task: TaskRecord): string {
    const models = this.config.routing.models;
    return (task.model_id && models[task.model_id]?.provider) || Object.values(models).find((m) => m.adapter === task.adapter)?.provider || task.adapter;
  }

  /**
   * A rate-limited task goes back to `ready` with `not_before` set to the provider's reset time
   * (or the next backoff step when it did not say). A reset beyond the automatic limit, or too
   * many waits, pauses the run instead; `navarch run resume` continues it.
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
      return [runStatus(task.run_id, runState, "paused", `${why}; continue with \`navarch run resume ${task.run_id}\``)];
    }
    const reason = `waiting for ${task.adapter} quota until ${untilIso}`;
    return [taskStatus(task.run_id, task.id, "failed", "ready", attempt, reason, undefined, untilIso)];
  }
}

function describeBudget(b: BudgetView): string {
  const scope = b.scope === "run" ? "run" : b.scope === "project_daily" ? `project ${b.label} today` : `global ${b.period}`;
  return `${scope} $${b.used.toFixed(2)} of $${(b.limit ?? 0).toFixed(2)}`;
}

/** Tasks whose failure the Flow engine weighs instead of failing the run at once. */
function flowDecidesFailure(task: TaskRecord): boolean {
  return task.team?.role === "member" || task.team?.role === "integrate" || task.compete?.role === "competitor" || task.parallel !== null;
}
