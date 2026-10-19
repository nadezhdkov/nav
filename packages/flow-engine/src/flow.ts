import { type FlowDefinition, type BodyNode, type CompeteTaskRef, type FlowNode, type ParallelTaskRef, type RunStatus, type SubflowNode, type TeamTaskRef } from "@navarch/contracts";
import { checkFlow, NOT_IN_SUBFLOW } from "./check.ts";
import { evaluate, isExpression, parseExpr, truthy, type Scope } from "./expr.ts";
import { competeOutputs, competeStep, competitorCount } from "./compete.ts";
import { parallelOutputs, parallelStarted, parallelStep } from "./parallel.ts";
import { teamState, teamStep } from "./team.ts";

export class FlowError extends Error {}

/** Parses and validates a Flow YAML document (spec §9.4, ADR 0011); throws the first error. */
export function parseFlow(text: string, source = "flow"): FlowDefinition {
  const { flow, problems } = checkFlow(text);
  const first = problems.find((p) => p.severity === "error");
  if (first || !flow) throw new FlowError(`${source}: ${first?.message ?? "invalid flow"}`);
  return flow;
}

/** Top-level nodes in execution order (the `edges` chain). */
export function chain(flow: FlowDefinition): FlowNode[] {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const ids = flow.edges.flatMap((e) => e.split("->").map((s) => s.trim()));
  const ordered: string[] = [];
  for (const id of ids) if (ordered.at(-1) !== id) ordered.push(id);
  return ordered.map((id) => byId.get(id)!);
}

/**
 * The Flows a flow's `subflow` nodes run, by name, checked against the loaded Flows: each must
 * exist, take the params `with` names, and hold no `team`, `compete` or `subflow` (ADR 0032).
 */
export function subflowsOf(flow: FlowDefinition, flows: ReadonlyMap<string, FlowDefinition>, source = `flows/${flow.metadata.name}`): Record<string, FlowDefinition> {
  const out: Record<string, FlowDefinition> = {};
  for (const node of flow.nodes) {
    if (node.type !== "subflow") continue;
    const child = flows.get(node.flow);
    if (!child) throw new FlowError(`${source}: node "${node.id}": unknown flow "${node.flow}" (known: ${[...flows.keys()].join(", ")})`);
    const nested = child.nodes.find((n) => NOT_IN_SUBFLOW.includes(n.type));
    if (nested) throw new FlowError(`${source}: node "${node.id}": flow "${node.flow}" cannot hold team, compete or subflow nodes, and has ${nested.type} "${nested.id}"`);
    for (const name of Object.keys(node.with ?? {})) {
      if (!(name in child.params)) throw new FlowError(`${source}: node "${node.id}": flow "${node.flow}" has no param "${name}"`);
    }
    out[node.flow] = child;
  }
  return out;
}

/** GitHub operations that act on a pull request the run works on, rather than open one. */
export const PR_USES = ["pr.review", "pr.comment"];

/** What a run of a Flow must start from. */
export type FlowNeeds = "prompt" | "issue" | "pull_request";

/**
 * What a run of `flow` must start from: a pull request when it (or a subflow) reviews or
 * comments on one, an issue when a top-level GitHub node opens a PR unconditionally (a node with
 * `when`, e.g. `project.work_item`, runs only if the condition holds), otherwise any prompt.
 */
export function flowNeeds(flow: FlowDefinition, subflows: Record<string, FlowDefinition> = {}): FlowNeeds {
  const all = [flow, ...Object.values(subflows)].flatMap((f) => f.nodes);
  if (all.some((n) => n.type === "github" && PR_USES.includes(n.uses))) return "pull_request";
  // `pr.specs` opens a PR for the specs a run wrote, so a prompt is enough (ADR 0048).
  if (flow.nodes.some((n) => n.type === "github" && !n.when && n.uses !== "pr.specs")) return "issue";
  return "prompt";
}

/** Default param values, overridden by the caller's. */
export function resolveParams(flow: FlowDefinition, given: Record<string, number | string | boolean> = {}): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const [name, p] of Object.entries(flow.params)) out[name] = given[name] ?? p.default;
  return out;
}

// --- execution ---

/** What the engine needs to know about one task of the run. */
export type TaskState = {
  node_id: string;
  iteration: number;
  status: "pending" | "ready" | "waiting_approval" | "blocked" | "running" | "paused" | "succeeded" | "failed" | "interrupted" | "cancelled";
  outputs: Record<string, unknown> | null;
};

export type RunContext = {
  params: Record<string, number | string | boolean>;
  project: Record<string, unknown>;
  tasks: TaskState[];
  /** Nodes already recorded as skipped. */
  skipped: string[];
  /** The run's copies of the Flows its `subflow` nodes run (ADR 0032). */
  subflows?: Record<string, FlowDefinition>;
};

export type NodeToStart = {
  /** A Flow node, or a node a `team` makes for its lead, members, checks and approval. */
  node: FlowNode | BodyNode | { id: string; type: "approval" };
  iteration: number;
  /** The run state while it runs (spec §8.4). */
  stage: RunStatus;
  /** Raw input values, rendered by the caller. */
  inputs: Record<string, unknown>;
  /** Text shown to an approver (approval nodes). */
  show: { path: string; value: unknown }[];
  /** The team a task belongs to (ADR 0022). */
  team?: TeamTaskRef;
  /** Create the task blocked, for this reason (a team waiting for the user's answer). */
  blocked?: string;
  /** An adapter or catalog entry the lead prefers for this member. */
  prefer?: string;
  /** The compete node a task belongs to (ADR 0031). */
  compete?: CompeteTaskRef;
  /** Options an approval lets the approver pick, the default first. */
  choices?: string[];
  /** The parallel node and branch a task belongs to (ADR 0036). */
  parallel?: ParallelTaskRef;
};

export type Step =
  | { kind: "start"; start: NodeToStart }
  | { kind: "skip"; nodeId: string; reason: string }
  | { kind: "wait" }
  /** Stop the active tasks of these nodes: branches a join no longer needs (ADR 0036). */
  | { kind: "cancel"; nodeIds: string[]; reason: string }
  | { kind: "done"; prOpened: boolean }
  | { kind: "fail"; reason: string };

const ACTIVE = new Set(["pending", "ready", "waiting_approval", "blocked", "running", "paused", "interrupted"]);

/**
 * The next step of a run: start a node, skip one whose `when` is false, wait for a task in
 * progress, finish, or fail. Pure: the Orchestrator records whatever it returns as events and
 * calls again, so a restart resumes from the event log.
 */
export function next(flow: FlowDefinition, ctx: RunContext): Step {
  const scope = scopeOf(ctx, flow);
  const nodes = chain(flow);
  for (const [index, node] of nodes.entries()) {
    if (node.type === "trigger" || ctx.skipped.includes(node.id)) continue;
    if (node.type === "loop") {
      const step = loopStep(node, ctx, scope);
      if (step) return step;
      continue;
    }
    if (node.type === "team") {
      if (node.when && !ctx.tasks.some((t) => t.node_id.startsWith(`${node.id}.`)) && !truthy(evaluate(parseExpr(node.when), scope))) {
        return { kind: "skip", nodeId: node.id, reason: `when ${node.when.replace(/^\$\{\{\s*|\s*\}\}$/g, "")} is false` };
      }
      const step = teamStep(node, ctx, scope);
      if (step) return step;
      continue;
    }
    if (node.type === "compete") {
      if (node.when && !ctx.tasks.some((t) => t.node_id.startsWith(`${node.id}.`)) && !truthy(evaluate(parseExpr(node.when), scope))) {
        return { kind: "skip", nodeId: node.id, reason: `when ${node.when.replace(/^\$\{\{\s*|\s*\}\}$/g, "")} is false` };
      }
      const step = competeStep(node, ctx, scope);
      if (step) return step;
      continue;
    }
    if (node.type === "subflow") {
      const step = subflowStep(node, ctx, scope);
      if (step) return step;
      continue;
    }
    if (node.type === "parallel") {
      if (node.when && !parallelStarted(node, ctx) && !truthy(evaluate(parseExpr(node.when), scope))) {
        return { kind: "skip", nodeId: node.id, reason: `when ${node.when.replace(/^\$\{\{\s*|\s*\}\}$/g, "")} is false` };
      }
      const step = parallelStep(node, ctx, scope, toStart);
      if (step) return step;
      continue;
    }
    const latest = latestTask(ctx, node.id);
    if (!latest) {
      if (node.when && !truthy(evaluate(parseExpr(node.when), scope))) {
        return { kind: "skip", nodeId: node.id, reason: `when ${node.when.replace(/^\$\{\{\s*|\s*\}\}$/g, "")} is false` };
      }
      return { kind: "start", start: toStart(node, 1, scope) };
    }
    if (ACTIVE.has(latest.status)) return { kind: "wait" };
    if (latest.status !== "succeeded") return { kind: "fail", reason: `node ${node.id} ${latest.status}` };
    if (node.type === "approval" && latest.outputs?.revise === true) {
      const revision = reviseStep(node, nodes[index - 1], latest, ctx, scope);
      if (revision) return revision;
      continue;
    }
    if (latest.outputs?.passed === false) return { kind: "fail", reason: `node ${node.id} reported a failed result` };
  }
  const last = chain(flow).at(-1);
  const opened = (f: FlowDefinition, prefix: string) => f.nodes.some((n) => n.type === "github" && (n.uses === "pr.create" || n.uses === "pr.specs") && latestTask(ctx, prefix + n.id)?.status === "succeeded");
  const prOpened = opened(flow, "") || flow.nodes.some((n) => n.type === "subflow" && !!ctx.subflows?.[n.flow] && opened(ctx.subflows[n.flow]!, `${n.id}.`));
  return last ? { kind: "done", prOpened } : { kind: "fail", reason: "empty flow" };
}

/** Most times a plan goes back through its approval gate: the original plus this many redone (ADR 0039). */
const MAX_REVISIONS = 3;

/**
 * An approval the approver answered by sending the plan back (ADR 0039): the node before it runs
 * again with the feedback, then the approval is asked again for the new plan. Undefined once the
 * approval of the redone plan has been decided by someone.
 */
function reviseStep(node: FlowNode, previous: FlowNode | undefined, revised: TaskState, ctx: RunContext, scope: Scope): Step | undefined {
  if (!previous || previous.type !== "agent") return { kind: "fail", reason: `node ${node.id} asked for a revision, but nothing before it can be redone` };
  if (revised.iteration > MAX_REVISIONS) return { kind: "fail", reason: `the plan was sent back ${MAX_REVISIONS} times` };
  const plan = latestTask(ctx, previous.id);
  if (!plan) return { kind: "fail", reason: `node ${previous.id} has no task to redo` };
  if (plan.iteration <= revised.iteration) {
    const start = toStart(previous, revised.iteration + 1, scope);
    const feedback = typeof revised.outputs?.feedback === "string" ? revised.outputs.feedback : "";
    const before = typeof plan.outputs?.summary === "string" ? plan.outputs.summary : "";
    return { kind: "start", start: { ...start, inputs: { ...start.inputs, revision_feedback: feedback, previous_plan: before } } };
  }
  return { kind: "start", start: toStart(node as Exclude<FlowNode, { type: "team" | "compete" | "subflow" | "parallel" }>, revised.iteration + 1, scope) };
}

/**
 * A subflow node's step (ADR 0032): the child's own `next()` over the child's tasks, with its node
 * ids prefixed by the node's id. Undefined once the child is done.
 */
function subflowStep(node: SubflowNode, ctx: RunContext, scope: Scope): Step | undefined {
  const prefix = `${node.id}.`;
  const started = ctx.tasks.some((t) => t.node_id.startsWith(prefix)) || ctx.skipped.some((s) => s.startsWith(prefix));
  if (!started && node.when && !truthy(evaluate(parseExpr(node.when), scope))) {
    return { kind: "skip", nodeId: node.id, reason: `when ${node.when.replace(/^\$\{\{\s*|\s*\}\}$/g, "")} is false` };
  }
  const child = ctx.subflows?.[node.flow];
  if (!child) return { kind: "fail", reason: `subflow ${node.id}: the run has no copy of flow "${node.flow}"` };
  const step = next(child, childContext(node, child, ctx, scope));
  switch (step.kind) {
    case "done":
      return undefined;
    case "wait":
      return step;
    case "cancel":
      return { ...step, nodeIds: step.nodeIds.map((id) => prefix + id) };
    case "fail":
      return { kind: "fail", reason: `subflow ${node.id}: ${step.reason}` };
    case "skip":
      return { kind: "skip", nodeId: prefix + step.nodeId, reason: step.reason };
    case "start": {
      const start = step.start;
      const extra: Record<string, unknown> = {};
      if (start.node.type === "agent") {
        for (const [name, value] of Object.entries(node.inputs ?? {})) extra[name] = isExpression(value) ? evaluate(parseExpr(value), scope) : value;
      }
      const parallel = start.parallel ? { parallel: { ...start.parallel, node_id: prefix + start.parallel.node_id } } : {};
      return { kind: "start", start: { ...start, node: { ...start.node, id: prefix + start.node.id }, inputs: { ...extra, ...start.inputs }, ...parallel } };
    }
  }
}

/** What the child sees: only its own tasks and skips, unprefixed, and its params from `with`. */
function childContext(node: SubflowNode, child: FlowDefinition, ctx: RunContext, scope: Scope): RunContext {
  const prefix = `${node.id}.`;
  const given: Record<string, number | string | boolean> = {};
  for (const [name, value] of Object.entries(node.with ?? {})) {
    if (typeof value !== "string" || !isExpression(value)) {
      given[name] = value;
      continue;
    }
    const v = evaluate(parseExpr(value), scope);
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") given[name] = v;
  }
  return {
    params: resolveParams(child, given),
    project: ctx.project,
    tasks: ctx.tasks.filter((t) => t.node_id.startsWith(prefix)).map((t) => ({ ...t, node_id: t.node_id.slice(prefix.length) })),
    skipped: ctx.skipped.filter((s) => s.startsWith(prefix)).map((s) => s.slice(prefix.length)),
  };
}

/** A subflow node's outputs: those of its child's last succeeded agent task. */
function subflowOutputs(node: SubflowNode, ctx: RunContext): Record<string, unknown> | undefined {
  const child = ctx.subflows?.[node.flow];
  if (!child) return undefined;
  const agents = new Set(child.nodes.flatMap((n): (FlowNode | BodyNode)[] => (n.type === "loop" ? n.body : n.type === "parallel" ? Object.values(n.branches).flat() : [n])).filter((n) => n.type === "agent").map((n) => `${node.id}.${n.id}`));
  return ctx.tasks.filter((t) => agents.has(t.node_id) && t.status === "succeeded").at(-1)?.outputs ?? undefined;
}

/**
 * Step progress of a run (slice 10): Flow nodes the engine has passed, in chain order, over all
 * nodes but the trigger. A loop counts its body nodes, and only those finished in its current
 * iteration, so a fix iteration counts once; a team, a compete node, a subflow or a parallel node counts once, when it is done.
 */
export function progress(flow: FlowDefinition, ctx: RunContext): { done: number; total: number } {
  const steps = chain(flow).filter((n) => n.type !== "trigger");
  const width = (n: FlowNode) => (n.type === "loop" ? n.body.length : 1);
  const total = steps.reduce((sum, n) => sum + width(n), 0);
  const scope = scopeOf(ctx, flow);
  let done = 0;
  for (const node of steps) {
    if (ctx.skipped.includes(node.id)) {
      done += width(node);
      continue;
    }
    if (node.type === "loop") {
      const iterations = ctx.tasks.filter((t) => node.body.some((b) => b.id === t.node_id)).map((t) => t.iteration);
      if (!iterations.length) break;
      if (safely(() => loopStep(node, ctx, scope)) === undefined) {
        done += width(node);
        continue;
      }
      const current = Math.max(...iterations);
      done += node.body.filter((b) => ctx.tasks.some((t) => t.node_id === b.id && t.iteration === current && t.status === "succeeded" && t.outputs?.passed !== false)).length;
      break;
    }
    if (node.type === "parallel") {
      if (!parallelStarted(node, ctx) || safely(() => parallelStep(node, ctx, scope, toStart)) !== undefined) break;
      done++;
      continue;
    }
    if (node.type === "team" || node.type === "compete" || node.type === "subflow") {
      const step = () => (node.type === "team" ? teamStep(node, ctx, scope) : node.type === "compete" ? competeStep(node, ctx, scope) : subflowStep(node, ctx, scope));
      if (!ctx.tasks.some((t) => t.node_id.startsWith(`${node.id}.`)) || safely(step) !== undefined) break;
      done++;
      continue;
    }
    const latest = latestTask(ctx, node.id);
    if (latest?.status !== "succeeded" || latest.outputs?.passed === false) break;
    done++;
  }
  return { done, total };
}

/** A step, or a placeholder when an expression cannot be evaluated from what the caller knows. */
function safely(step: () => Step | undefined): Step | undefined {
  try {
    return step();
  } catch {
    return { kind: "wait" };
  }
}

function loopStep(node: Extract<FlowNode, { type: "loop" }>, ctx: RunContext, scope: Scope): Step | undefined {
  const iterations = ctx.tasks.filter((t) => node.body.some((b) => b.id === t.node_id)).map((t) => t.iteration);
  const current = iterations.length ? Math.max(...iterations) : 0;
  if (current === 0) {
    if (node.when && !truthy(evaluate(parseExpr(node.when), scope))) {
      return { kind: "skip", nodeId: node.id, reason: `when ${node.when.replace(/^\$\{\{\s*|\s*\}\}$/g, "")} is false` };
    }
    return { kind: "start", start: toStart(node.body[0]!, 1, scope) };
  }
  for (const body of node.body) {
    const t = ctx.tasks.find((x) => x.node_id === body.id && x.iteration === current);
    if (!t) return { kind: "start", start: toStart(body, current, scope) };
    if (ACTIVE.has(t.status)) return { kind: "wait" };
    if (t.status !== "succeeded") return { kind: "fail", reason: `node ${body.id} ${t.status} in iteration ${current}` };
  }
  if (truthy(evaluate(parseExpr(node.until), scope))) return undefined;
  const max = typeof node.max_iterations === "number" ? node.max_iterations : Number(evaluate(parseExpr(node.max_iterations), scope));
  if (!Number.isFinite(max) || current >= max) {
    return { kind: "fail", reason: `${node.id} stopped after ${current} iteration(s): ${node.until.replace(/^\$\{\{\s*|\s*\}\}$/g, "")} is still false` };
  }
  return { kind: "start", start: toStart(node.body[0]!, current + 1, scope) };
}

function latestTask(ctx: RunContext, nodeId: string): TaskState | undefined {
  return ctx.tasks.filter((t) => t.node_id === nodeId).sort((a, b) => a.iteration - b.iteration).at(-1);
}

/** `nodes.<id>.outputs` is the latest finished task of each node. */
function scopeOf(ctx: RunContext, flow?: FlowDefinition): Scope {
  const nodes: Record<string, { outputs: Record<string, unknown>; status: string; iteration: number }> = {};
  for (const t of [...ctx.tasks].sort((a, b) => a.iteration - b.iteration)) {
    if (t.status === "succeeded" || !nodes[t.node_id]) nodes[t.node_id] = { outputs: t.outputs ?? {}, status: t.status, iteration: t.iteration };
  }
  // A team's output is its lead's latest plan summary.
  for (const n of flow?.nodes ?? []) {
    if (n.type !== "team") continue;
    const summary = teamState(n.id, ctx.tasks).summary;
    if (summary !== undefined) nodes[n.id] = { outputs: { summary }, status: "succeeded", iteration: 1 };
  }
  // A compete node's output is its winner's summary and why it won, once adopted.
  for (const n of flow?.nodes ?? []) {
    if (n.type !== "compete") continue;
    let count: number;
    try {
      count = competitorCount(n, { nodes, params: ctx.params, project: ctx.project });
    } catch {
      continue;
    }
    const outputs = competeOutputs(n.id, count, ctx.tasks);
    if (outputs) nodes[n.id] = { outputs, status: "succeeded", iteration: 1 };
  }
  // A subflow's output is its child's last succeeded agent task's (ADR 0032).
  for (const n of flow?.nodes ?? []) {
    if (n.type !== "subflow") continue;
    const outputs = subflowOutputs(n, ctx);
    if (outputs) nodes[n.id] = { outputs, status: "succeeded", iteration: 1 };
  }
  // A parallel node's output is its branches' summaries, once joined (ADR 0036).
  for (const n of flow?.nodes ?? []) {
    if (n.type !== "parallel") continue;
    const outputs = parallelOutputs(n, ctx);
    if (outputs) nodes[n.id] = { outputs, status: "succeeded", iteration: 1 };
  }
  return { nodes, params: ctx.params, project: ctx.project };
}

function toStart(node: Exclude<FlowNode, { type: "team" | "compete" | "subflow" | "parallel" }> | BodyNode, iteration: number, scope: Scope): NodeToStart {
  const inputs: Record<string, unknown> = {};
  if (node.type === "agent") {
    for (const [name, value] of Object.entries(node.inputs ?? {})) inputs[name] = isExpression(value) ? evaluate(parseExpr(value), scope) : value;
  }
  const show = node.type === "approval" ? (node.show ?? []).map((path) => ({ path, value: evaluate(parseExpr(`\${{ ${path} }}`), scope) })) : [];
  return { node, iteration, stage: stageOf(node), inputs, show };
}

/** Spec §8.4: the run state a node puts the run in. */
export function stageOf(node: NodeToStart["node"]): RunStatus {
  switch (node.type) {
    case "approval":
      return "awaiting_approval";
    case "action":
      return node.uses === "verification.run" ? "verifying" : "executing";
    case "github":
      return "ready_for_pr";
    case "agent":
      return ["triager", "planner", "explorer", "ci-fixer"].includes(node.profile) ? "planning" : ["reviewer", "judge", "pr-reviewer"].includes(node.profile) ? "reviewing" : "executing";
    default:
      return "executing";
  }
}
