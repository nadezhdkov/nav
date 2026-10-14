import { resolve } from "node:path";
import {
  isTerminalRun,
  isTerminalTask,
  newId,
  type Actor,
  type ApprovalView,
  type CreateRunRequest,
  type TaskError,
  type WorkItem,
  type NewEvent,
  type RunStatus,
  type RunView,
  type TaskStatus,
} from "@vectr/contracts";
import { resolveHead, resolveRepoRoot } from "@vectr/runner";
import type { Config } from "../config.ts";
import type { EventStore } from "../events/store.ts";
import { GitHubIntegrationError, type GitHubIntegration } from "../github/integration.ts";
import { loadProjectConfig } from "../project.ts";
import { issuePrompt } from "./issue.ts";
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
 * Orchestrator (spec §6.1.1). There is no Flow engine yet: a run is a fixed chain of nodes,
 * `implement` (agent) → `verify` (action) → `open_pr` (github, issue runs only), mirroring the
 * `fix-issue` Flow of spec §9.4. Status changes are always written as events.
 */
export class Orchestrator {
  private readonly store: EventStore;
  private readonly config: Config;
  private readonly adapters: string[];
  private readonly onReady: () => void;
  private readonly github: GitHubIntegration | undefined;

  constructor(store: EventStore, config: Config, adapters: string[], onReady: () => void, github?: GitHubIntegration) {
    this.store = store;
    this.config = config;
    this.adapters = adapters;
    this.onReady = onReady;
    this.github = github;
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

    let project;
    try {
      project = await loadProjectConfig(repoPath, baseCommit);
    } catch (err) {
      throw new OrchestratorError("invalid_project", (err as Error).message);
    }
    let workItem: WorkItem | undefined;
    if (req.issue) {
      if (!this.github) throw new OrchestratorError("github_unavailable", "the GitHub Integration is not configured");
      try {
        workItem = await this.github.readIssue(repoPath, req.issue);
      } catch (err) {
        if (err instanceof GitHubIntegrationError) throw new OrchestratorError(err.code, err.message);
        throw new OrchestratorError("github_error", (err as Error).message);
      }
    }
    const prompt = workItem ? issuePrompt(workItem, req.prompt) : req.prompt;
    if (!prompt) throw new OrchestratorError("invalid_request", "a run needs a prompt or an issue");

    const runId = newId("run");
    const taskId = newId("task");
    const nodes: { id: string; type: string; profile: string; adapter: string }[] = [
      { id: "verify", type: "action", profile: "verifier", adapter: "runner" },
      ...(workItem ? [{ id: "open_pr", type: "github", profile: "github", adapter: "github" }] : []),
    ];
    const followers: NewEvent[] = nodes.map((node) => ({
      type: "task.created",
      run_id: runId,
      task_id: newId("task"),
      actor: system("orchestrator"),
      payload: { node_id: node.id, type: node.type, profile: node.profile, adapter: node.adapter, max_attempts: this.config.scheduler.max_attempts },
    }));
    this.store.append([
      {
        type: "run.created",
        run_id: runId,
        task_id: null,
        actor,
        payload: {
          repo_path: repoPath,
          base_commit: baseCommit,
          prompt,
          budget: req.budget ?? this.config.budgets.default_run,
          adapter,
          profile: implementer.id,
          allow_commands: [...this.config.allow_commands, ...project.allowlist, ...(req.allow_commands ?? [])],
          setup_commands: [...project.setup, ...(req.setup_commands ?? [])],
          ...(model ? { model } : {}),
          ...(workItem ? { work_item: { source: workItem.source, repo: workItem.repo, number: workItem.number, url: workItem.url } } : {}),
          verify: project.verify,
          protected_paths: project.protected_paths,
        },
      },
      ...(workItem ? [{ type: "workitem.received", run_id: runId, task_id: null, actor: system("github"), payload: workItem } as NewEvent] : []),
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
      ...followers,
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
   * A human decides a pending approval (spec §6.10.3). Approving puts the waiting task back in the
   * queue, where the Scheduler sees the approval and dispatches it; rejecting cancels the task and
   * the run.
   */
  decideApproval(id: string, decision: "approve" | "reject", reason: string | undefined, actor: Actor): ApprovalView {
    const approval = this.store.getApproval(id);
    if (!approval) throw new OrchestratorError("not_found", `approval ${id} not found`);
    if (approval.status !== "pending") throw new OrchestratorError("conflict", `approval ${id} is already ${approval.status}`);
    const task = this.store.getTask(approval.task_id)!;
    const run = this.store.getRun(approval.run_id)!;
    const decided: NewEvent = {
      type: "approval.decided",
      run_id: run.id,
      task_id: task.id,
      actor,
      payload: { approval_id: id, decision: decision === "approve" ? "approved" : "rejected", ...(reason ? { reason } : {}) },
    };
    if (decision === "approve") {
      this.store.append([decided, taskStatus(run.id, task.id, "waiting_approval", "ready", task.attempt, "approved", undefined)]);
      this.onReady();
    } else {
      const why = `${approval.action} rejected${reason ? `: ${reason}` : ""}`;
      this.store.append([
        decided,
        taskStatus(run.id, task.id, "waiting_approval", "cancelled", task.attempt, why),
        runStatus(run.id, run.status, "cancelled", why, actor),
      ]);
    }
    return this.store.getApproval(id)!;
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
