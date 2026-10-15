import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canTransitionRun,
  isTerminalRun,
  isTerminalTask,
  newId,
  type Actor,
  type ApprovalView,
  type CreateRunRequest,
  type TaskError,
  type FlowDefinition,
  type WorkItem,
  type NewEvent,
  type RunStatus,
  type RunView,
  type TaskStatus,
} from "@navarch/contracts";
import { next, parseFlow, renderInputs, renderValue, resolveParams, type TaskState } from "@navarch/flow-engine";
import { resolveHead, resolveRepoRoot } from "@navarch/runner";
import type { Config } from "../config.ts";
import type { EventStore } from "../events/store.ts";
import { GitHubIntegrationError, type GitHubIntegration } from "../github/integration.ts";
import { loadProjectConfig } from "../project.ts";
import { issuePrompt } from "./issue.ts";
import { implementer, PROFILES } from "./profiles.ts";

/** The repository's built-in Flows (spec §13 `flows/`). */
export const FLOWS_DIR = fileURLToPath(new URL("../../../../flows/", import.meta.url));

/** Loads every `*.yaml` Flow of a directory; an invalid one stops the daemon from starting. */
export function loadFlows(dir: string = FLOWS_DIR): Map<string, FlowDefinition> {
  const flows = new Map<string, FlowDefinition>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()) {
    const flow = parseFlow(readFileSync(join(dir, file), "utf8"), `flows/${file}`);
    if (flows.has(flow.metadata.name)) throw new Error(`flows/${file}: a flow named ${flow.metadata.name} already exists`);
    flows.set(flow.metadata.name, flow);
  }
  return flows;
}

export class OrchestratorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const system = (component: string): Actor => ({ kind: "system", component });

/**
 * Orchestrator (spec §6.1.1): turns a request into a run of a Flow and advances its TaskGraph.
 * Tasks are created as their nodes become due (so a loop can add iterations); the Flow engine
 * decides what is next from the tasks recorded so far. Status changes are always events.
 */
export class Orchestrator {
  private readonly store: EventStore;
  private readonly config: Config;
  private readonly adapters: string[];
  private readonly onReady: () => void;
  private readonly github: GitHubIntegration | undefined;
  private readonly flows: Map<string, FlowDefinition>;

  constructor(
    store: EventStore,
    config: Config,
    adapters: string[],
    onReady: () => void,
    github?: GitHubIntegration,
    flows: Map<string, FlowDefinition> = loadFlows(),
  ) {
    this.store = store;
    this.config = config;
    this.adapters = adapters;
    this.onReady = onReady;
    this.github = github;
    this.flows = flows;
  }

  flowNames(): string[] {
    return [...this.flows.keys()];
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
    // An explicit adapter or model is a manual override (spec §6.4.2 step 7): it pins the run.
    const routing = this.config.routing.enabled && !req.adapter && !req.model ? "auto" : "pinned";
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

    const flowName = req.flow ?? (workItem ? "fix-issue" : "task");
    const flow = this.flows.get(flowName);
    if (!flow) throw new OrchestratorError("unknown_flow", `flow "${flowName}" not found; available: ${this.flowNames().join(", ")}`);
    const usesGitHub = flow.nodes.some((n) => n.type === "github");
    if (usesGitHub && !workItem) throw new OrchestratorError("invalid_request", `flow "${flowName}" opens a PR and needs an issue (--issue owner/repo#N)`);

    const runId = newId("run");
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
          flow: { definition: flow, params: resolveParams(flow) },
          autonomy_level: project.autonomy_level ?? this.config.autonomy_level,
          routing,
        },
      },
      ...(workItem ? [{ type: "workitem.received", run_id: runId, task_id: null, actor: system("github"), payload: workItem } as NewEvent] : []),
    ]);
    this.advance(runId);
    this.onReady();
    return this.store.getRun(runId)!;
  }

  /**
   * Moves a run's TaskGraph forward after a task succeeded (or a run started): creates the next
   * node's task, records skipped nodes, or ends the run. Runs created before Flows keep their
   * fixed chain of pre-created tasks.
   */
  advance(runId: string): void {
    for (let guard = 0; guard < 100; guard++) {
      const run = this.store.getRunRecord(runId);
      if (!run || isTerminalRun(run.status) || run.status === "paused") return;
      const tasks = this.store.taskRecordsOfRun(runId);
      if (!run.flow_definition) return this.advanceLegacy(run.id, run.status, tasks);

      const step = next(run.flow_definition.definition, {
        params: run.flow_definition.params,
        project: { autonomy_level: run.autonomy_level ?? this.config.autonomy_level },
        tasks: tasks.map((t): TaskState => ({ node_id: t.node_id, iteration: t.iteration, status: t.status, outputs: t.outputs })),
        skipped: this.store.skippedNodes(runId),
      });
      switch (step.kind) {
        case "wait":
          return;
        case "skip":
          this.store.append([{ type: "flow.node.skipped", run_id: runId, task_id: null, actor: system("orchestrator"), payload: { node_id: step.nodeId, reason: step.reason } }]);
          continue;
        case "fail": {
          const verify = tasks.filter((t) => t.uses === "verification.run").at(-1)?.outputs?.blocking_failures;
          const detail = Array.isArray(verify) && verify.length ? `; last failures: ${verify.join("; ")}` : "";
          this.store.append([runStatus(runId, run.status, "failed", step.reason + detail)]);
          return;
        }
        case "done": {
          const events: NewEvent[] = [];
          let from = run.status;
          if (step.prOpened && from !== "pr_opened") {
            events.push(runStatus(runId, from, "pr_opened", "draft PR opened"));
            from = "pr_opened";
          }
          events.push(runStatus(runId, from, "done", "all nodes finished"));
          this.store.append(events);
          return;
        }
        case "start": {
          const { node, iteration, stage } = step.start;
          const taskId = newId("task");
          const agent = node.type === "agent";
          const profile = agent ? node.profile : node.type;
          if (agent && !PROFILES.has(node.profile)) {
            this.store.append([runStatus(runId, run.status, "failed", `flow node ${node.id}: unknown profile ${node.profile}`)]);
            return;
          }
          const adapter = agent ? (node.adapter ?? run.adapter) : node.type === "github" ? "github" : node.type === "approval" ? "human" : "runner";
          // A node's own `adapter` pins it; otherwise a routed run lets the Model Router choose at dispatch.
          const routed = agent && !node.adapter && run.routing === "auto";
          const inputs = node.type === "approval"
            ? Object.fromEntries(step.start.show.flatMap(({ path, value }) => (renderValue(value) ? [[path, renderValue(value)!]] : [])))
            : renderInputs(step.start.inputs);
          this.store.append([
            {
              type: "task.created",
              run_id: runId,
              task_id: taskId,
              actor: system("orchestrator"),
              payload: {
                node_id: node.id,
                type: node.type,
                profile,
                adapter,
                max_attempts: this.config.scheduler.max_attempts,
                iteration,
                stage,
                ...(node.type === "action" || node.type === "github" ? { uses: node.uses } : {}),
                ...(Object.keys(inputs).length ? { inputs } : {}),
                ...(routed ? { routing: "auto" as const } : {}),
              },
            },
            taskStatus(runId, taskId, "pending", "ready", 0, iteration > 1 ? `iteration ${iteration}` : "node due"),
          ]);
          this.onReady();
          return;
        }
      }
    }
  }

  /** Runs created before Flows: their tasks were created up front and run in order. */
  private advanceLegacy(runId: string, status: RunStatus, tasks: { id: string; node_id: string; status: TaskStatus }[]): void {
    const pending = tasks.find((t) => t.status === "pending");
    if (pending) {
      this.store.append([taskStatus(runId, pending.id, "pending", "ready", 0, "previous task succeeded")]);
      this.onReady();
      return;
    }
    if (tasks.some((t) => !isTerminalTask(t.status))) return;
    const events: NewEvent[] = [];
    let from = status;
    if (tasks.some((t) => t.node_id === "open_pr") && canTransitionRun(from, "pr_opened")) {
      events.push(runStatus(runId, from, "pr_opened", "open_pr succeeded"));
      from = "pr_opened";
    }
    events.push(runStatus(runId, from, "done", "all tasks succeeded"));
    this.store.append(events);
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
    // A run whose task finished just before a stop may not have advanced yet.
    for (const run of this.store.listRuns(1000)) if (!isTerminalRun(run.status)) this.advance(run.id);
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
