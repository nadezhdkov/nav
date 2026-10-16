import type { FlowDefinition, FlowNode, TaskStatus, TaskView } from "@navarch/contracts";

/**
 * Builds the read-only TaskGraph view (spec §6.2.4) from a run's own Flow copy and its tasks.
 * Presentation only: states come from the tasks the Core reports, nothing is decided here.
 */

export type NodeState = TaskStatus | "not_started" | "skipped";

export type GraphNode = {
  id: string;
  kind: FlowNode["type"];
  label: string;
  /** Agent profile, or the action a deterministic node uses. */
  detail: string | null;
  state: NodeState;
  /** The node's latest task (highest iteration, then the newest). */
  task: TaskView | null;
  /** Every task of this node, oldest first. */
  tasks: TaskView[];
  /** Current iteration of a loop, or of a node inside one. */
  iteration: number | null;
  maxIterations: number | string | null;
  /** The loop a body node belongs to. */
  parent: string | null;
  /** For a parallel node (ADR 0036): the branch of each of its nodes. */
  branchOf?: Record<string, string>;
  /** Relative to the parent for body nodes. */
  position: { x: number; y: number };
  width: number;
  height: number;
};

/** `wrap` marks the edge from the end of one row to the start of the next. */
export type GraphEdge = { id: string; source: string; target: string; kind: "flow" | "loop-back"; active: boolean; wrap: boolean };

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 96;
const GAP = 48;
const LOOP_PAD = 24;
const LOOP_HEADER = 36;
/** Long Flows wrap into rows so nodes stay readable instead of shrinking to fit. */
export const ROW_WIDTH = 1000;
const ROW_GAP = 72;

const TEAM_ACTIVE = new Set(["running", "waiting_approval", "blocked", "paused", "interrupted", "ready"]);

export function buildGraph(
  flow: FlowDefinition,
  tasks: readonly TaskView[],
  skipped: readonly string[],
  params: Readonly<Record<string, number | string | boolean>> = {},
) {
  const byNode = new Map<string, TaskView[]>();
  for (const t of tasks) byNode.set(t.node_id, [...(byNode.get(t.node_id) ?? []), t]);
  const skippedSet = new Set(skipped);
  const started = tasks.length > 0;

  const leaf = (node: FlowNode, parent: string | null, position: { x: number; y: number }): GraphNode => {
    // A team node (ADR 0022) stands for its lead's turns, members, checks and approval; a compete
    // node (ADR 0031) for its competitors, their checks, the judge, the pick and the adoption; a
    // subflow (ADR 0032) for its child Flow's tasks.
    // A parallel node (ADR 0036) stands for its branches' nodes, which keep their own ids.
    const branchOf = node.type === "parallel" ? Object.fromEntries(Object.entries(node.branches).flatMap(([key, list]) => list.map((b) => [b.id, key]))) : undefined;
    const composite = node.type === "team" || node.type === "compete" || node.type === "subflow" || node.type === "parallel";
    const own = branchOf ? tasks.filter((t) => t.node_id in branchOf) : composite ? tasks.filter((t) => t.node_id.startsWith(`${node.id}.`)) : (byNode.get(node.id) ?? []);
    const latest = composite ? (own.find((t) => TEAM_ACTIVE.has(t.status)) ?? latestTask(own)) : latestTask(own);
    let state: NodeState = latest?.status ?? "not_started";
    if (!latest && skippedSet.has(node.id)) state = "skipped";
    if (!latest && node.type === "trigger" && started) state = "succeeded";
    return {
      id: node.id,
      kind: node.type,
      label: node.name ?? node.id,
      detail: node.type === "agent" ? node.profile : node.type === "team" ? node.lead.profile : node.type === "compete" ? competeDetail(node, params) : node.type === "subflow" ? node.flow : node.type === "parallel" ? `${Object.keys(node.branches).length} × · ${node.join}` : "uses" in node ? node.uses : null,
      state,
      task: latest,
      tasks: own,
      iteration: parent && latest ? latest.iteration : null,
      maxIterations: null,
      parent,
      ...(branchOf ? { branchOf } : {}),
      position,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  };

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const order = chainOrder(flow);
  const nodeById = new Map(flow.nodes.map((n) => [n.id, n]));
  const rowHeight = LOOP_HEADER + NODE_HEIGHT + LOOP_PAD * 2;
  const rowOf = new Map<string, number>();
  let x = 0;
  let row = 0;
  const place = (width: number) => {
    if (x > 0 && x + width > ROW_WIDTH) {
      row++;
      x = 0;
    }
    return row * (rowHeight + ROW_GAP);
  };

  for (const id of order) {
    const node = nodeById.get(id);
    if (!node) continue;
    if (node.type !== "loop") {
      const y = place(NODE_WIDTH);
      rowOf.set(node.id, row);
      nodes.push(leaf(node, null, { x, y: y + LOOP_HEADER + LOOP_PAD }));
      x += NODE_WIDTH + GAP;
      continue;
    }
    const children = node.body.map((b, i) =>
      leaf(b, node.id, { x: LOOP_PAD + i * (NODE_WIDTH + GAP), y: LOOP_HEADER }),
    );
    const width = LOOP_PAD * 2 + node.body.length * NODE_WIDTH + (node.body.length - 1) * GAP;
    const y = place(width);
    rowOf.set(node.id, row);
    const iteration = Math.max(0, ...children.flatMap((c) => c.tasks.map((t) => t.iteration)));
    nodes.push({
      id: node.id,
      kind: "loop",
      label: node.name ?? node.id,
      detail: null,
      state: loopState(children, iteration, skippedSet.has(node.id)),
      task: null,
      tasks: [],
      iteration: iteration || null,
      maxIterations: resolveParam(node.max_iterations, flow, params),
      parent: null,
      position: { x, y },
      width,
      height: rowHeight,
    });
    nodes.push(...children);
    for (let i = 1; i < children.length; i++) edges.push(edge(children[i - 1]!, children[i]!, "flow"));
    if (children.length > 1) edges.push(edge(children.at(-1)!, children[0]!, "loop-back"));
    x += width + GAP;
  }

  const top = new Map(nodes.filter((n) => !n.parent).map((n) => [n.id, n]));
  for (let i = 1; i < order.length; i++) {
    const a = top.get(order[i - 1]!);
    const b = top.get(order[i]!);
    if (a && b) edges.push(edge(a, b, "flow", rowOf.get(a.id) !== rowOf.get(b.id)));
  }
  return { nodes, edges };
}

/** `edges` is one chain written as `a -> b -> c`, possibly split over several strings. */
export function chainOrder(flow: FlowDefinition): string[] {
  const order: string[] = [];
  for (const line of flow.edges) {
    for (const id of line.split("->").map((s) => s.trim())) {
      if (id && order.at(-1) !== id && !order.includes(id)) order.push(id);
    }
  }
  return order;
}

/** Shows `${{ params.x }}` as the run's value (or the Flow's default); other expressions stay as written. */
function resolveParam(value: number | string, flow: FlowDefinition, params: Readonly<Record<string, number | string | boolean>>) {
  if (typeof value === "number") return value;
  const name = /^\$\{\{\s*params\.([a-z0-9_]+)\s*\}\}$/i.exec(value)?.[1];
  if (!name) return value;
  const resolved = params[name] ?? flow.params[name]?.default;
  return typeof resolved === "number" || typeof resolved === "string" ? resolved : value;
}

function latestTask(tasks: readonly TaskView[]): TaskView | null {
  let best: TaskView | null = null;
  for (const t of tasks) if (!best || t.iteration >= best.iteration) best = t;
  return best;
}

const ACTIVE: readonly NodeState[] = ["running", "ready", "paused", "interrupted"];

function loopState(children: readonly GraphNode[], iteration: number, skipped: boolean): NodeState {
  if (iteration === 0) return skipped ? "skipped" : "not_started";
  const current = children.map((c) => (c.task?.iteration === iteration ? c.state : "not_started"));
  if (current.some((s) => ACTIVE.includes(s))) return "running";
  if (current.includes("waiting_approval")) return "waiting_approval";
  if (current.includes("blocked")) return "blocked";
  if (current.includes("cancelled")) return "cancelled";
  if (current.every((s) => s === "succeeded")) return "succeeded";
  if (current.includes("failed") && current.at(-1) !== "not_started") return "failed";
  return "running";
}

function edge(a: GraphNode, b: GraphNode, kind: GraphEdge["kind"], wrap = false): GraphEdge {
  const active = kind === "flow" && a.state === "succeeded" && b.state !== "not_started" && b.state !== "skipped";
  return { id: `${a.id}->${b.id}${kind === "loop-back" ? ":back" : ""}`, source: a.id, target: b.id, kind, active, wrap };
}

/** "3 × implementer · judge": how many compete, and who judges. */
function competeDetail(node: Extract<FlowNode, { type: "compete" }>, params: Readonly<Record<string, number | string | boolean>>): string {
  const n = typeof node.competitors === "number" ? node.competitors : params[/params\.(\w+)/.exec(node.competitors)?.[1] ?? ""];
  return `${typeof n === "number" ? `${n} × ` : ""}implementer · ${node.judge.profile}`;
}
