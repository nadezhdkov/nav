import type { FlowDefinition, FlowNode, SimulatedOutcome, SimulatedStep, SimulationResult } from "@navarch/contracts";
import { next, resolveParams, type RunContext } from "./flow.ts";

export type SimulateOptions = {
  params?: Record<string, number | string | boolean>;
  /** For `when` conditions on `project.autonomy_level`; 2 by default. */
  autonomy_level?: number;
  /** Per node id (`<subflow>.<node>` inside a subflow): its outputs per iteration, or a failure. */
  outcomes?: Record<string, SimulatedOutcome>;
  /** The Flows its `subflow` nodes run. */
  subflows?: Record<string, FlowDefinition>;
  maxSteps?: number;
};

/**
 * A dry run (spec §6.2.3, ADR 0033): walks the Flow with the engine's own `next()`, finishing each
 * started task with the outputs the caller chose once the engine waits, so the branches of a
 * `parallel` node start together as in a run. No tasks, events or agents. A `team` or `compete`
 * node is one step, since what happens inside it is decided by agents.
 */
export function simulateFlow(flow: FlowDefinition, opts: SimulateOptions = {}): Omit<SimulationResult, "problems"> {
  const types = new Map<string, string>();
  const standIn = (n: FlowNode): FlowNode => {
    if (n.type !== "team" && n.type !== "compete") return n;
    types.set(n.id, n.type);
    return { id: n.id, type: "agent", profile: n.type === "team" ? n.lead.profile : n.judge.profile, ...(n.name ? { name: n.name } : {}), ...(n.when ? { when: n.when } : {}) };
  };
  const sim: FlowDefinition = { ...flow, nodes: flow.nodes.map(standIn) };
  const ctx: RunContext = {
    params: resolveParams(flow, opts.params),
    project: { autonomy_level: opts.autonomy_level ?? 2 },
    tasks: [],
    skipped: [],
    subflows: opts.subflows ?? {},
  };
  const steps: SimulatedStep[] = [];
  const max = opts.maxSteps ?? 200;
  // Started tasks run until the engine has nothing else to start, then finish together.
  const running: { task: RunContext["tasks"][number]; step: Extract<SimulatedStep, { kind: "start" }>; status: "succeeded" | "failed" }[] = [];
  while (steps.length < max) {
    const step = next(sim, ctx);
    if (step.kind === "done") return { steps, end: { kind: "done", pr_opened: step.prOpened } };
    if (step.kind === "fail") return { steps, end: { kind: "fail", reason: step.reason } };
    if (step.kind === "wait") {
      if (!running.length) return { steps, end: { kind: "fail", reason: "the flow waits for a task that never finishes" } };
      for (const r of running.splice(0)) r.task.status = r.step.status = r.status;
      continue;
    }
    if (step.kind === "cancel") {
      for (const r of running.filter((x) => step.nodeIds.includes(x.task.node_id))) {
        running.splice(running.indexOf(r), 1);
        r.task.status = r.step.status = "cancelled";
      }
      continue;
    }
    if (step.kind === "skip") {
      ctx.skipped.push(step.nodeId);
      steps.push({ kind: "skip", node: step.nodeId, reason: step.reason });
      continue;
    }
    const { node, iteration, stage } = step.start;
    const outcome = opts.outcomes?.[node.id];
    const given = Array.isArray(outcome?.outputs) ? outcome.outputs[Math.min(iteration, outcome.outputs.length) - 1] : outcome?.outputs;
    const outputs: Record<string, unknown> = given ?? defaultOutputs(node);
    if (types.has(node.id) && !("summary" in outputs)) outputs.summary = "(simulated)";
    const task: RunContext["tasks"][number] = { node_id: node.id, iteration, status: "running", outputs };
    ctx.tasks.push(task);
    const started: Extract<SimulatedStep, { kind: "start" }> = { kind: "start", node: node.id, type: types.get(node.id) ?? node.type, iteration, stage, status: "succeeded", outputs };
    steps.push(started);
    running.push({ task, step: started, status: outcome?.fail ? "failed" : "succeeded" });
  }
  return { steps, end: { kind: "limit" } };
}

function defaultOutputs(node: { type: string; uses?: string }): Record<string, unknown> {
  if (node.type === "action" && node.uses === "verification.run") return { passed: true };
  if (node.type === "agent") return { summary: "(simulated)" };
  return {};
}
