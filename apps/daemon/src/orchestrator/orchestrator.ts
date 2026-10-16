import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canTransitionRun,
  isTerminalRun,
  isTerminalTask,
  newId,
  PAUSE_INTERRUPT,
  type Actor,
  type ApprovalView,
  type CreateRunRequest,
  type TaskError,
  type FlowDefinition,
  type WorkItem,
  type NewEvent,
  type RunMessage,
  type RunStatus,
  type RunView,
  type SendRunMessage,
  type TaskStatus,
} from "@navarch/contracts";
import { next, parseFlow, renderInputs, renderValue, resolveParams, subflowsOf, type TaskState } from "@navarch/flow-engine";
import { pullRequestDiff, resolveHead, resolveRepoRoot } from "@navarch/runner";
import type { Config } from "../config.ts";
import type { EventStore } from "../events/store.ts";
import { GitHubIntegrationError, type GitHubIntegration } from "../github/integration.ts";
import { loadProjectConfig } from "../project.ts";
import { PolicyEngine } from "../policy/engine.ts";
import { issuePrompt, prPrompt } from "./issue.ts";
import { implementer, PROFILES } from "./profiles.ts";
import { uniqueCodename } from "./names.ts";

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
  // Every subflow names a loaded Flow it may run (ADR 0032).
  for (const flow of flows.values()) subflowsOf(flow, flows);
  return flows;
}

/** A Flow a run can name: a built-in, or the latest published version of a Studio Flow (ADR 0033). */
export type ResolvedFlow = { definition: FlowDefinition; source: "builtin" | "studio"; version?: number };

/** Where the Orchestrator looks Flows up. */
export interface FlowLookup {
  get(name: string): ResolvedFlow | undefined;
  /** Every Flow a run or a subflow can name now. */
  all(): ReadonlyMap<string, FlowDefinition>;
  /** Why a name that `get` does not find cannot run, when there is more to say than "not found". */
  missing?(name: string): string | undefined;
}

/** The built-in Flows alone, as a lookup. */
export function builtinLookup(flows: ReadonlyMap<string, FlowDefinition>): FlowLookup {
  return { get: (name) => (flows.has(name) ? { definition: flows.get(name)!, source: "builtin" } : undefined), all: () => flows };
}

/** GitHub operations that work on a pull request rather than on an issue (ADR 0032). */
const PR_USES = ["pr.review", "pr.comment"];

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
  private readonly flows: FlowLookup;
  private readonly policy: PolicyEngine;

  constructor(
    store: EventStore,
    config: Config,
    adapters: string[],
    onReady: () => void,
    github?: GitHubIntegration,
    flows: Map<string, FlowDefinition> | FlowLookup = loadFlows(),
    policy: PolicyEngine = new PolicyEngine(),
  ) {
    this.store = store;
    this.config = config;
    this.adapters = adapters;
    this.onReady = onReady;
    this.github = github;
    this.flows = flows instanceof Map ? builtinLookup(flows) : flows;
    this.policy = policy;
  }

  flowNames(): string[] {
    return [...this.flows.all().keys()];
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

    if (req.issue && req.pull_request) throw new OrchestratorError("invalid_request", "a run works on an issue or a pull request, not both");
    let workItem: WorkItem | undefined;
    if (req.issue || req.pull_request) {
      if (!this.github) throw new OrchestratorError("github_unavailable", "the GitHub Integration is not configured");
      try {
        workItem = req.pull_request ? await this.github.readPullRequest(repoPath, req.pull_request) : await this.github.readIssue(repoPath, req.issue!);
      } catch (err) {
        if (err instanceof GitHubIntegrationError) throw new OrchestratorError(err.code, err.message);
        throw new OrchestratorError("github_error", (err as Error).message);
      }
    }
    const pr = workItem?.pull_request;
    // A run on a pull request works on its head, but its project config comes from its base: the
    // pull request cannot change what Navarch runs on it (ADR 0032, T1).
    if (pr) baseCommit = pr.head_sha;
    let project;
    try {
      project = await loadProjectConfig(repoPath, pr ? pr.base_sha : baseCommit);
    } catch (err) {
      throw new OrchestratorError("invalid_project", (err as Error).message);
    }

    const flowName = req.flow ?? (pr ? "review-pr" : workItem ? "fix-issue" : "task");
    const resolved = this.flows.get(flowName);
    if (!resolved) {
      const why = this.flows.missing?.(flowName);
      if (why) throw new OrchestratorError("invalid_request", why);
      throw new OrchestratorError("unknown_flow", `flow "${flowName}" not found; available: ${this.flowNames().join(", ")}`);
    }
    const flow = resolved.definition;
    const params = flowParams(flow, flowName, req.params);
    let subflows: Record<string, FlowDefinition>;
    try {
      subflows = subflowsOf(flow, this.flows.all());
    } catch (err) {
      throw new OrchestratorError("invalid_request", (err as Error).message);
    }
    const allNodes = [flow, ...Object.values(subflows)].flatMap((f) => f.nodes);
    const onPr = allNodes.some((n) => n.type === "github" && PR_USES.includes(n.uses));
    if (onPr && !pr) throw new OrchestratorError("invalid_request", `flow "${flowName}" works on a pull request (--pr owner/repo#N)`);
    if (pr && !onPr) throw new OrchestratorError("invalid_request", `flow "${flowName}" does not work on pull requests; use review-pr or ci-fix`);
    // ci-fix pushes a branch into the pull request's repository and runs its code in verification.
    if (pr && allNodes.some((n) => n.type === "agent" && n.profile === "ci-fixer")) {
      if (pr.head_repo.toLowerCase() !== workItem!.repo.toLowerCase()) {
        throw new OrchestratorError("invalid_request", `${workItem!.repo}#${workItem!.number} comes from ${pr.head_repo}; ${flowName} works on pull requests whose branch is in ${workItem!.repo}`);
      }
      if (!pr.failing_checks.length) throw new OrchestratorError("invalid_request", `${workItem!.repo}#${workItem!.number} has no failing checks on ${pr.head_sha.slice(0, 7)}`);
    }
    const prompt = pr ? prPrompt(workItem!, await pullRequestDiff(repoPath, pr.base_sha, pr.head_sha), req.prompt) : workItem ? issuePrompt(workItem, req.prompt) : req.prompt;
    if (!prompt) throw new OrchestratorError("invalid_request", "a run needs a prompt, an issue or a pull request");
    // N competitors multiply the cost: Compete mode needs a budget the user chose (ADR 0031).
    if (flow.nodes.some((n) => n.type === "compete") && req.budget === undefined) {
      throw new OrchestratorError("budget_required", `flow "${flowName}" runs several agents on the same task; give it a run budget (--budget <usd>)`);
    }
    // A PR node that runs only `when` something holds (e.g. `project.work_item`) does not need an issue.
    const usesGitHub = flow.nodes.some((n) => n.type === "github" && !n.when);
    if (usesGitHub && !workItem) throw new OrchestratorError("invalid_request", `flow "${flowName}" opens a PR and needs an issue (--issue owner/repo#N)`);
    // A run that will push finds out now, not after all the agent work (go/no-go finding F5).
    if (workItem && this.github && allNodes.some((n) => n.type === "github" && n.uses === "pr.create")) {
      try {
        await this.github.checkPush(repoPath, workItem.repo);
      } catch (err) {
        if (err instanceof GitHubIntegrationError) throw new OrchestratorError(err.code, err.message);
        throw err;
      }
    }

    const runId = newId("run");
    const name = uniqueCodename(runId, (n) => this.store.runIdByName(n) !== undefined);
    this.store.append([
      {
        type: "run.created",
        run_id: runId,
        task_id: null,
        actor,
        payload: {
          name,
          repo_path: repoPath,
          base_commit: baseCommit,
          prompt,
          budget: req.budget ?? this.config.budgets.default_run,
          adapter,
          profile: implementer.id,
          allow_commands: [...this.config.allow_commands, ...project.allowlist, ...(req.allow_commands ?? [])],
          setup_commands: [...project.setup, ...(req.setup_commands ?? [])],
          ...(model ? { model } : {}),
          ...(workItem ? { work_item: { source: workItem.source, ...(pr ? { kind: "pull_request" as const } : {}), repo: workItem.repo, number: workItem.number, url: workItem.url } } : {}),
          verify: project.verify,
          protected_paths: project.protected_paths,
          flow: { definition: flow, params, ...(Object.keys(subflows).length ? { subflows } : {}), ...(resolved.source === "studio" ? { source: "studio" as const, version: resolved.version } : {}) },
          autonomy_level: project.autonomy_level ?? this.config.autonomy_level,
          routing,
          ...(req.attachments?.length ? { attachments: req.attachments } : {}),
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
    let started = false;
    try {
      this.step(runId, () => (started = true));
    } finally {
      if (started) this.onReady();
    }
  }

  /** One pass of `advance`; a parallel team starts several tasks in one pass (ADR 0029). */
  private step(runId: string, onStarted: () => void): void {
    for (let guard = 0; guard < 100; guard++) {
      const run = this.store.getRunRecord(runId);
      if (!run || isTerminalRun(run.status) || run.status === "paused") return;
      const tasks = this.store.taskRecordsOfRun(runId);
      if (!run.flow_definition) return this.advanceLegacy(run.id, run.status, tasks);

      const step = next(run.flow_definition.definition, {
        params: run.flow_definition.params,
        project: { autonomy_level: run.autonomy_level ?? this.config.autonomy_level, work_item: run.work_item !== null },
        tasks: tasks.map((t): TaskState => ({ node_id: t.node_id, iteration: t.iteration, status: t.status, outputs: t.outputs })),
        skipped: this.store.skippedNodes(runId),
        ...(run.flow_definition.subflows ? { subflows: run.flow_definition.subflows } : {}),
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
          const team = step.start.team;
          const compete = step.start.compete;
          // A node's own `adapter` pins it; otherwise a routed run lets the Model Router choose at dispatch.
          // Team members are routed whenever routing is on, so the lead's preference counts (ADR 0022),
          // and so are competitors, which must differ (ADR 0031).
          const routed = agent && !node.adapter && (run.routing === "auto" || ((team?.role === "member" || compete?.role === "competitor") && this.config.routing.enabled));
          const inputs = node.type === "approval"
            ? Object.fromEntries(step.start.show.flatMap(({ path, value }) => (renderValue(value) ? [[path, renderValue(value)!]] : [])))
            : renderInputs(step.start.inputs);
          if (team?.role === "lead") {
            const agents = this.agentsForLead();
            if (agents) inputs.agents = agents;
          }
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
                ...(team ? { team } : {}),
                ...(step.start.prefer ? { prefer: step.start.prefer } : {}),
                ...(compete ? { compete } : {}),
                ...(step.start.choices?.length ? { choices: step.start.choices } : {}),
              },
            },
            taskStatus(runId, taskId, "pending", "ready", 0, iteration > 1 ? `iteration ${iteration}` : "node due"),
            // A lead's turn after a question waits for the user's answer (ADR 0022).
            ...(step.start.blocked ? [taskStatus(runId, taskId, "ready", "blocked", 0, step.start.blocked)] : []),
          ]);
          onStarted();
          continue;
        }
      }
    }
  }

  /**
   * The agents a team lead may prefer (ADR 0022): enabled catalog entries with what is known of
   * their quota, so the lead favours agents that can run now.
   */
  private agentsForLead(): string | undefined {
    if (!this.config.routing.enabled) return undefined;
    const exhausted = this.store.exhaustedQuotas();
    const lines = Object.entries(this.config.routing.models)
      .filter(([, m]) => m.status === "active" && this.adapters.includes(m.adapter))
      .map(([id, m]) => {
        const q = exhausted.find((x) => x.adapter === m.adapter && (!x.modelPrefix || (m.model ?? "").startsWith(x.modelPrefix)));
        return `- ${id} (${m.adapter}${m.model ? `, ${m.model}` : ""}): ${q ? `quota exhausted until ${q.resetsAt}` : "available"}`;
      });
    return lines.length ? lines.join("\n") : undefined;
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
  decideApproval(id: string, decision: "approve" | "reject", reason: string | undefined, actor: Actor, choice?: string): ApprovalView {
    const approval = this.store.getApproval(id);
    if (!approval) throw new OrchestratorError("not_found", `approval ${id} not found`);
    if (approval.status !== "pending") throw new OrchestratorError("conflict", `approval ${id} is already ${approval.status}`);
    // A pick among options (ADR 0031): only when approving, and only one of the offered choices.
    if (choice !== undefined) {
      if (decision !== "approve") throw new OrchestratorError("invalid_request", "a choice goes with approve, not reject");
      if (!approval.choices.includes(choice)) {
        throw new OrchestratorError("invalid_request", approval.choices.length ? `choice must be one of: ${approval.choices.join(", ")}` : `approval ${id} has no choices`);
      }
    }
    const task = this.store.getTask(approval.task_id)!;
    const run = this.store.getRun(approval.run_id)!;
    const decided: NewEvent = {
      type: "approval.decided",
      run_id: run.id,
      task_id: task.id,
      actor,
      payload: { approval_id: id, decision: decision === "approve" ? "approved" : "rejected", ...(reason ? { reason } : {}), ...(choice !== undefined ? { choice } : {}) },
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
   * Records an instruction from the user to a run (ADR 0019). `next` waits for the next agent
   * attempt that starts; `now` interrupts the running task so it resumes with the message. The
   * Policy Engine decides `run.message` first; an instruction never changes what agents may do.
   */
  sendMessage(
    runId: string,
    req: SendRunMessage,
    actor: Actor,
    deps: {
      decide: (actor: Actor, runId: string) => { effect: "allow" | "deny" | "require_approval"; reason: string };
      resumable: (adapter: string) => boolean;
      interrupt: (taskId: string) => boolean;
    },
  ): RunMessage {
    const run = this.store.getRun(runId);
    if (!run) throw new OrchestratorError("not_found", `run ${runId} not found`);
    const task = req.task_id ? this.store.getTask(req.task_id) : undefined;
    if (req.task_id && (!task || task.run_id !== runId)) throw new OrchestratorError("not_found", `task ${req.task_id} not found in run ${runId}`);
    if (isTerminalRun(run.status)) throw new OrchestratorError("conflict", `run ${runId} is already ${run.status}`);
    if (task && task.type !== "agent") throw new OrchestratorError("conflict", `task ${task.id} is not an agent`);
    if (task && isTerminalTask(task.status)) {
      throw new OrchestratorError("conflict", `task ${task.id} is ${task.status}; send the instruction to the run instead`);
    }
    if (req.delivery === "now") {
      if (!task) throw new OrchestratorError("conflict", "an instruction delivered now needs the running task it interrupts");
      if (task.status !== "running") throw new OrchestratorError("conflict", `task ${task.id} is ${task.status}, not running`);
      if (!deps.resumable(task.adapter)) {
        throw new OrchestratorError("conflict", `${task.adapter} cannot resume a session; send the instruction for its next turn`);
      }
    }
    const decision = deps.decide(actor, runId);
    if (decision.effect !== "allow") {
      this.store.append([
        { type: "policy.denied", run_id: runId, task_id: task?.id ?? null, actor, payload: { action: "run.message", resource: runId, reason: decision.reason } },
      ]);
      throw new OrchestratorError("forbidden", decision.reason);
    }
    const id = newId("msg");
    this.store.append([
      {
        type: "run.message",
        run_id: runId,
        task_id: task?.id ?? null,
        actor,
        payload: { message_id: id, text: req.text, delivery: req.delivery, ...(task ? { task_id: task.id } : {}) },
      },
    ]);
    // If the attempt ended in the meantime, the message waits for the task's next attempt, if it gets one.
    if (req.delivery === "now") deps.interrupt(task!.id);
    // An answer to a team lead's question lets its next turn start (ADR 0022).
    const waiting = this.store.taskRecordsOfRun(runId).find((t) => t.status === "blocked" && t.team?.role === "lead" && (!task || t.id === task.id));
    if (waiting) {
      this.store.append([taskStatus(runId, waiting.id, "blocked", "ready", waiting.attempt, "the user answered")]);
      this.onReady();
    }
    return this.store.listMessages(runId).find((m) => m.id === id)!;
  }

  /**
   * Pauses a run (ADR 0020): nothing of it is dispatched until it is resumed, and its running
   * tasks are interrupted without using an attempt, so resumable agents continue their session.
   */
  pauseRun(runId: string, actor: Actor, interrupt: (taskId: string) => boolean, reason = "user"): RunView {
    const run = this.store.getRun(runId);
    if (!run) throw new OrchestratorError("not_found", `run ${runId} not found`);
    if (run.status === "paused") throw new OrchestratorError("conflict", `run ${runId} is already paused`);
    if (!canTransitionRun(run.status, "paused")) throw new OrchestratorError("conflict", `run ${runId} is ${run.status} and cannot be paused`);
    this.authorize(actor, "run.pause", runId);
    // The status changes first, so the Scheduler records each interrupted attempt as a pause.
    this.store.append([runStatus(runId, run.status, "paused", reason, actor)]);
    for (const task of this.store.tasksOfRun(runId)) {
      if (task.status === "running") interrupt(task.id);
    }
    return this.store.getRun(runId)!;
  }

  /** The kill switch (spec §6.12.4): pauses every active run, which can then be resumed or cancelled. */
  stopAll(actor: Actor, interrupt: (taskId: string) => boolean): string[] {
    this.authorize(actor, "fleet.stop", "*");
    const paused: string[] = [];
    for (const run of this.store.listRuns(10_000)) {
      if (run.status === "paused" || !canTransitionRun(run.status, "paused")) continue;
      this.pauseRun(run.id, actor, interrupt, "kill switch");
      paused.push(run.id);
    }
    this.store.append([{ type: "fleet.stopped", run_id: null, task_id: null, actor, payload: { run_ids: paused } }]);
    return paused;
  }

  /**
   * Continues a paused run (spec §10, `/runs/:id/resume`) in the status it had before the pause.
   * Tasks that failed on a quota are requeued and keep their resume token, so the agent continues
   * the same conversation; tasks interrupted by the pause are already ready.
   */
  resumeRun(runId: string, actor: Actor): RunView {
    const run = this.store.getRun(runId);
    if (!run) throw new OrchestratorError("not_found", `run ${runId} not found`);
    if (run.status === "failed") return this.retryRun(runId, actor);
    if (run.status !== "paused") throw new OrchestratorError("conflict", `run ${runId} is ${run.status}, not paused or failed`);
    this.authorize(actor, "run.resume", runId);

    const before = this.statusBeforePause(runId);
    const events: NewEvent[] = [runStatus(runId, "paused", before, "resumed by user", actor)];
    for (const task of this.store.tasksOfRun(runId)) {
      if (task.status === "failed") events.push(taskStatus(runId, task.id, "failed", "ready", task.attempt, "run resumed by user"));
    }
    this.store.append(events);
    // A task may have succeeded while the run was paused; its successor is due now.
    this.advance(runId);
    this.onReady();
    return this.store.getRun(runId)!;
  }

  /**
   * Retries a run that failed on a task (ADR 0025): the run returns to the stage it failed in and
   * its failed tasks are requeued, keeping their approvals and resume tokens, so finished work is
   * not redone. A run that failed on a flow decision (e.g. a fix loop out of iterations) has no
   * failed task and would only fail again.
   */
  private retryRun(runId: string, actor: Actor): RunView {
    const failed = this.store.tasksOfRun(runId).filter((t) => t.status === "failed");
    if (!failed.length) throw new OrchestratorError("conflict", `run ${runId} has no failed task to retry; it failed on a flow decision`);
    this.authorize(actor, "run.resume", runId);
    const before = this.statusBefore(runId, "failed");
    this.store.append([
      runStatus(runId, "failed", before, "retried by user", actor),
      ...failed.map((task) => taskStatus(runId, task.id, "failed", "ready", task.attempt, "run retried by user")),
    ]);
    this.onReady();
    return this.store.getRun(runId)!;
  }

  private statusBefore(runId: string, status: "failed"): RunStatus {
    const events = this.store.events({ runId });
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type !== "run.status_changed") continue;
      const p = e.payload as { from: RunStatus; to: RunStatus };
      if (p.to === status) return canTransitionRun(status, p.from) ? p.from : "executing";
    }
    return "executing";
  }

  private statusBeforePause(runId: string): RunStatus {
    const events = this.store.events({ runId });
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type !== "run.status_changed") continue;
      const p = e.payload as { from: RunStatus; to: RunStatus };
      if (p.to === "paused") return canTransitionRun("paused", p.from) ? p.from : "executing";
    }
    return "executing";
  }

  private authorize(actor: Actor, action: string, resource: string): void {
    const decision = this.policy.decide(actor, action, resource, { autonomyLevel: this.config.autonomy_level });
    if (decision.effect === "allow") return;
    this.store.append([{ type: "policy.denied", run_id: resource.startsWith("run_") ? resource : null, task_id: null, actor, payload: { action, resource, reason: decision.reason } }]);
    throw new OrchestratorError("forbidden", decision.reason);
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

/**
 * The Flow's params with the caller's values (ADR 0031). Each must name a declared param and fit
 * its type; text such as `"2"` or `"true"` (from `--param`) is read as that type.
 */
function flowParams(flow: FlowDefinition, flowName: string, given: CreateRunRequest["params"]): Record<string, number | string | boolean> {
  const values: Record<string, number | string | boolean> = {};
  for (const [name, raw] of Object.entries(given ?? {})) {
    const param = flow.params[name];
    if (!param) {
      const known = Object.keys(flow.params);
      throw new OrchestratorError("invalid_request", `flow "${flowName}" has no param "${name}"${known.length ? `; params: ${known.join(", ")}` : ""}`);
    }
    const text = typeof raw === "string" ? raw.trim() : undefined;
    const value = param.type === "string" ? raw : param.type === "bool" ? (text === "true" ? true : text === "false" ? false : raw) : text !== undefined && text !== "" ? Number(text) : raw;
    const ok = param.type === "int" ? Number.isInteger(value) : param.type === "money" ? typeof value === "number" && Number.isFinite(value) && value >= 0 : param.type === "bool" ? typeof value === "boolean" : typeof value === "string";
    if (!ok) throw new OrchestratorError("invalid_request", `param "${name}" of flow "${flowName}" must be ${param.type === "int" ? "an integer" : param.type === "money" ? "an amount" : param.type === "bool" ? "true or false" : "text"}`);
    values[name] = value;
  }
  return resolveParams(flow, values);
}
