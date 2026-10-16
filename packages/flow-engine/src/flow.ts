import { FlowDefinition, PHASE_2_NODE_TYPES, type BodyNode, type CompeteTaskRef, type FlowNode, type RunStatus, type SubflowNode, type TeamTaskRef } from "@navarch/contracts";
import { parse } from "yaml";
import { evaluate, exprPaths, isExpression, parseExpr, truthy, type Scope } from "./expr.ts";
import { competeOutputs, competeStep, competitorCount } from "./compete.ts";
import { teamState, teamStep } from "./team.ts";

export class FlowError extends Error {}

/** Operations an `action` or `github` node may name; the daemon registers an executor for each. */
export const KNOWN_USES: Record<"action" | "github", readonly string[]> = {
  action: ["verification.run"],
  github: ["pr.create", "pr.review", "pr.comment"],
};

/** Parses and validates a Flow YAML document (spec §9.4, ADR 0011). */
export function parseFlow(text: string, source = "flow"): FlowDefinition {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new FlowError(`${source}: invalid YAML: ${(err as Error).message}`);
  }
  const later = laterNodeType(raw);
  if (later) throw new FlowError(`${source}: node type "${later}" is not supported until Phase 2`);
  const parsed = FlowDefinition.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new FlowError(`${source}: ${issue.path.join(".") || "flow"}: ${issue.message}`);
  }
  validate(parsed.data, source);
  return parsed.data;
}

function laterNodeType(raw: unknown): string | undefined {
  const nodes = (raw as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) return undefined;
  const all = nodes.flatMap((n) => [n, ...(Array.isArray(n?.body) ? n.body : [])]);
  return all.map((n) => n?.type).find((t) => (PHASE_2_NODE_TYPES as readonly string[]).includes(t));
}

/** Top-level nodes in execution order (the `edges` chain). */
export function chain(flow: FlowDefinition): FlowNode[] {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const ids = flow.edges.flatMap((e) => e.split("->").map((s) => s.trim()));
  const ordered: string[] = [];
  for (const id of ids) if (ordered.at(-1) !== id) ordered.push(id);
  return ordered.map((id) => byId.get(id)!);
}

function validate(flow: FlowDefinition, source: string): void {
  const fail = (msg: string): never => {
    throw new FlowError(`${source}: ${msg}`);
  };
  const all = flow.nodes.flatMap((n): (FlowNode | BodyNode)[] => (n.type === "loop" ? [n, ...n.body] : [n]));
  const ids = new Set<string>();
  for (const n of all) {
    if (ids.has(n.id)) fail(`duplicate node id "${n.id}"`);
    ids.add(n.id);
  }

  // One linear chain naming every top-level node once.
  const order = flow.edges.flatMap((e) => e.split("->").map((s) => s.trim()));
  if (order.some((id) => !id)) fail("edges must look like `a -> b -> c`");
  const seen: string[] = [];
  for (const id of order) {
    if (!flow.nodes.some((n) => n.id === id)) fail(`edge names unknown top-level node "${id}"`);
    if (seen.at(-1) === id) continue;
    if (seen.includes(id)) fail(`node "${id}" appears twice in edges; Phase 1 flows are a single chain`);
    seen.push(id);
  }
  for (const n of flow.nodes) if (!seen.includes(n.id)) fail(`node "${n.id}" is not in edges`);
  const trigger = flow.nodes.filter((n) => n.type === "trigger");
  if (trigger.length > 1 || (trigger.length === 1 && seen[0] !== trigger[0]!.id)) fail("a flow has at most one trigger, and it comes first");

  for (const n of all) {
    if ((n.type === "action" || n.type === "github") && !KNOWN_USES[n.type].includes(n.uses)) {
      fail(`node "${n.id}": unknown ${n.type} "${n.uses}" (known: ${KNOWN_USES[n.type].join(", ")})`);
    }
    for (const text of expressionsOf(n)) {
      let expr;
      try {
        expr = parseExpr(text);
      } catch (err) {
        fail(`node "${n.id}": ${(err as Error).message}`);
      }
      for (const path of exprPaths(expr!)) {
        if (path[0] === "nodes" && !ids.has(path[1] ?? "")) fail(`node "${n.id}" refers to unknown node "${path[1]}"`);
        if (path[0] === "params" && !(path[1]! in flow.params)) fail(`node "${n.id}" refers to unknown param "${path[1]}"`);
      }
    }
  }
}

function expressionsOf(n: FlowNode | BodyNode): string[] {
  const out: string[] = [];
  if (n.when) out.push(n.when);
  if (n.type === "agent") out.push(...Object.values(n.inputs ?? {}).filter(isExpression));
  if (n.type === "loop") {
    out.push(n.until);
    if (typeof n.max_iterations === "string") out.push(n.max_iterations);
  }
  if (n.type === "approval") out.push(...(n.show ?? []).map((p) => `\${{ ${p} }}`));
  if (n.type === "team") {
    for (const v of [n.max_turns, n.max_members, n.approve_first_plan, n.parallel, n.max_parallel]) if (typeof v === "string") out.push(v);
  }
  if (n.type === "compete") {
    for (const v of [n.competitors, n.max_fix_iterations, n.approve_pick]) if (typeof v === "string") out.push(v);
  }
  if (n.type === "subflow") {
    out.push(...[...Object.values(n.with ?? {}), ...Object.values(n.inputs ?? {})].filter((v): v is string => typeof v === "string" && isExpression(v)));
  }
  return out;
}

/** Node types a subflow's child may not hold: one level, and no composite nodes (ADR 0032). */
const NOT_IN_SUBFLOW = ["team", "compete", "subflow"];

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
};

export type Step =
  | { kind: "start"; start: NodeToStart }
  | { kind: "skip"; nodeId: string; reason: string }
  | { kind: "wait" }
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
  for (const node of chain(flow)) {
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
    const latest = latestTask(ctx, node.id);
    if (!latest) {
      if (node.when && !truthy(evaluate(parseExpr(node.when), scope))) {
        return { kind: "skip", nodeId: node.id, reason: `when ${node.when.replace(/^\$\{\{\s*|\s*\}\}$/g, "")} is false` };
      }
      return { kind: "start", start: toStart(node, 1, scope) };
    }
    if (ACTIVE.has(latest.status)) return { kind: "wait" };
    if (latest.status !== "succeeded") return { kind: "fail", reason: `node ${node.id} ${latest.status}` };
    if (latest.outputs?.passed === false) return { kind: "fail", reason: `node ${node.id} reported a failed result` };
  }
  const last = chain(flow).at(-1);
  const opened = (f: FlowDefinition, prefix: string) => f.nodes.some((n) => n.type === "github" && n.uses === "pr.create" && latestTask(ctx, prefix + n.id)?.status === "succeeded");
  const prOpened = opened(flow, "") || flow.nodes.some((n) => n.type === "subflow" && !!ctx.subflows?.[n.flow] && opened(ctx.subflows[n.flow]!, `${n.id}.`));
  return last ? { kind: "done", prOpened } : { kind: "fail", reason: "empty flow" };
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
      return { kind: "start", start: { ...start, node: { ...start.node, id: prefix + start.node.id }, inputs: { ...extra, ...start.inputs } } };
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
  const agents = new Set(child.nodes.flatMap((n): (FlowNode | BodyNode)[] => (n.type === "loop" ? n.body : [n])).filter((n) => n.type === "agent").map((n) => `${node.id}.${n.id}`));
  return ctx.tasks.filter((t) => agents.has(t.node_id) && t.status === "succeeded").at(-1)?.outputs ?? undefined;
}

/**
 * Step progress of a run (slice 10): Flow nodes the engine has passed, in chain order, over all
 * nodes but the trigger. A loop counts its body nodes, and only those finished in its current
 * iteration, so a fix iteration counts once; a team, a compete node or a subflow counts once, when it is done.
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
  return { nodes, params: ctx.params, project: ctx.project };
}

function toStart(node: Exclude<FlowNode, { type: "team" | "compete" | "subflow" }> | BodyNode, iteration: number, scope: Scope): NodeToStart {
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
