import { joinNeeds, type BodyNode, type ParallelNode } from "@navarch/contracts";
import { evaluate, parseExpr, truthy, type Scope } from "./expr.ts";
import type { NodeToStart, RunContext, Step, TaskState } from "./flow.ts";

/**
 * Generic `parallel` nodes (ADR 0036): every branch runs its nodes in order, all branches at
 * once, and `join` decides when the node is done. Branch nodes keep their own ids; the engine
 * reads a branch's state from the run's tasks of those ids alone.
 */

const ACTIVE = new Set(["pending", "ready", "waiting_approval", "blocked", "running", "paused", "interrupted"]);

export type BranchState = {
  key: string;
  state: "working" | "succeeded" | "failed" | "cancelled";
  /** Why it failed or was cancelled. */
  reason?: string;
  /** The summary of its last succeeded agent node. */
  summary?: string;
};

const latest = (tasks: readonly TaskState[], id: string) => tasks.filter((t) => t.node_id === id).sort((a, b) => a.iteration - b.iteration).at(-1);

/** Where each branch is, from its nodes' tasks and skips. */
export function branchStates(node: ParallelNode, ctx: Pick<RunContext, "tasks" | "skipped">): BranchState[] {
  return Object.entries(node.branches).map(([key, nodes]): BranchState => {
    let summary: string | undefined;
    for (const n of nodes) {
      if (ctx.skipped.includes(n.id)) continue;
      const t = latest(ctx.tasks, n.id);
      if (!t || ACTIVE.has(t.status)) return { key, state: "working", ...(summary !== undefined ? { summary } : {}) };
      if (t.status === "cancelled") return { key, state: "cancelled", reason: `${n.id} was cancelled` };
      if (t.status !== "succeeded") return { key, state: "failed", reason: `${n.id} ${t.status}` };
      if (t.outputs?.passed === false) {
        const failures = Array.isArray(t.outputs.blocking_failures) ? t.outputs.blocking_failures.map(String) : [];
        return { key, state: "failed", reason: `${n.id} reported a failed result${failures.length ? `: ${failures.join("; ")}` : ""}` };
      }
      if (n.type === "agent" && typeof t.outputs?.summary === "string") summary = t.outputs.summary;
    }
    return { key, state: "succeeded", ...(summary !== undefined ? { summary } : {}) };
  });
}

/** Whether the node has started: a task or a skip of any of its branch nodes. */
export function parallelStarted(node: ParallelNode, ctx: Pick<RunContext, "tasks" | "skipped">): boolean {
  const ids = new Set(branchNodeIds(node));
  return ctx.tasks.some((t) => ids.has(t.node_id)) || ctx.skipped.some((s) => ids.has(s));
}

export const branchNodeIds = (node: ParallelNode): string[] => Object.values(node.branches).flatMap((nodes) => nodes.map((n) => n.id));

/**
 * The node's next step, or undefined once it is done. Once the join is met, or can no longer be,
 * the branches still working are cancelled first, so a branch that is not needed stops spending.
 */
export function parallelStep(node: ParallelNode, ctx: RunContext, scope: Scope, toStart: (n: BodyNode, iteration: number, scope: Scope) => NodeToStart): Step | undefined {
  const states = branchStates(node, ctx);
  const need = joinNeeds(node.join, states.length);
  const succeeded = states.filter((b) => b.state === "succeeded").length;
  const working = states.filter((b) => b.state === "working").length;
  const settled = succeeded >= need || succeeded + working < need;
  if (settled) {
    const active = branchNodeIds(node).filter((id) => {
      const t = latest(ctx.tasks, id);
      return t !== undefined && ACTIVE.has(t.status);
    });
    if (active.length) {
      const why = succeeded >= need ? `${node.id} joined (${node.join})` : `${node.id} can no longer join (${node.join})`;
      return { kind: "cancel", nodeIds: active, reason: `not needed: ${why}` };
    }
    if (succeeded >= need) return undefined;
    const reasons = states.filter((b) => b.state === "failed" || b.state === "cancelled").map((b) => `${b.key}: ${b.reason}`);
    return { kind: "fail", reason: `${node.id}: ${succeeded} of ${states.length} branch(es) succeeded, ${node.join} needs ${need}${reasons.length ? `; ${reasons.join("; ")}` : ""}` };
  }
  // Start or skip the next node of every branch still working; the Orchestrator asks again after each.
  for (const [key, nodes] of Object.entries(node.branches)) {
    if (states.find((b) => b.key === key)!.state !== "working") continue;
    for (const n of nodes) {
      if (ctx.skipped.includes(n.id)) continue;
      const t = latest(ctx.tasks, n.id);
      if (t && ACTIVE.has(t.status)) break;
      if (t) continue;
      if (n.when && !truthy(evaluate(parseExpr(n.when), scope))) return { kind: "skip", nodeId: n.id, reason: `when ${n.when.replace(/^\$\{\{\s*|\s*\}\}$/g, "")} is false` };
      const start = toStart(n, 1, scope);
      return { kind: "start", start: { ...start, parallel: { node_id: node.id, branch: key } } };
    }
  }
  return { kind: "wait" };
}

/** The node's outputs once joined: every branch's summary under its name, and which succeeded. */
export function parallelOutputs(node: ParallelNode, ctx: Pick<RunContext, "tasks" | "skipped">): Record<string, unknown> | undefined {
  const states = branchStates(node, ctx);
  const succeeded = states.filter((b) => b.state === "succeeded");
  if (succeeded.length < joinNeeds(node.join, states.length) || states.some((b) => b.state === "working")) return undefined;
  return {
    summary: succeeded.map((b) => `### ${b.key}\n\n${b.summary ?? "(no summary)"}`).join("\n\n"),
    succeeded: succeeded.map((b) => b.key),
    failed: states.filter((b) => b.state !== "succeeded").map((b) => b.key),
    branches: Object.fromEntries(states.map((b) => [b.key, { state: b.state, ...(b.summary !== undefined ? { summary: b.summary } : {}) }])),
  };
}
