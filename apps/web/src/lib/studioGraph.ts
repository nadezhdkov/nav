import type { FlowProblem, SimulationResult } from "@navarch/contracts";
import type { DraftNode, DraftView } from "./flowDoc.ts";
import { NODE_HEIGHT, NODE_WIDTH, ROW_WIDTH } from "./graph.ts";

/**
 * Flow Studio's canvas (ADR 0033), laid out like the run's TaskGraph: the chain left to right,
 * wrapping into rows, loops as lanes around their body. Nodes outside the chain go in a last row,
 * marked disconnected. Positions are never stored: they always come from the chain.
 */

export type SimState = "succeeded" | "failed" | "skipped";

export type StudioNode = {
  id: string;
  type: string;
  label: string;
  detail: string | null;
  parent: string | null;
  /** In the chain (a body node counts as connected through its loop). */
  connected: boolean;
  errors: number;
  warnings: number;
  /** The dry run's outcome for this node, and how many times it ran. */
  sim: SimState | null;
  runs: number;
  position: { x: number; y: number };
  width: number;
  height: number;
};

export type StudioEdge = { id: string; source: string; target: string; kind: "flow" | "loop-back"; wrap: boolean; simulated: boolean };

const GAP = 48;
const LOOP_PAD = 24;
const LOOP_HEADER = 36;
const ROW_GAP = 72;
const ROW_HEIGHT = LOOP_HEADER + NODE_HEIGHT + LOOP_PAD * 2;

/** `${{ params.x }}` as the param's default, so the canvas shows a value instead of the expression. */
function shown(value: unknown, params: DraftView["params"]): string {
  const name = typeof value === "string" ? /^\$\{\{\s*params\.([a-z0-9_]+)\s*\}\}$/i.exec(value)?.[1] : undefined;
  return name && params[name] ? `${String(params[name].default)} (${name})` : String(value);
}

export function detailOf(n: DraftNode, params: DraftView["params"] = {}): string | null {
  const r = n.raw as Record<string, unknown> & { lead?: { profile?: unknown }; judge?: { profile?: unknown } };
  switch (n.type) {
    case "agent":
      return typeof r.profile === "string" ? r.profile : null;
    case "action":
    case "github":
      return typeof r.uses === "string" ? r.uses : null;
    case "team":
      return typeof r.lead?.profile === "string" ? r.lead.profile : null;
    case "compete":
      return `${r.competitors === undefined ? "?" : shown(r.competitors, params)} × · ${typeof r.judge?.profile === "string" ? r.judge.profile : "?"}`;
    case "subflow":
      return typeof r.flow === "string" ? r.flow : null;
    case "loop":
      return r.max_iterations !== undefined ? `≤ ${shown(r.max_iterations, params)}` : null;
    default:
      return null;
  }
}

export function buildStudioGraph(view: DraftView, problems: readonly FlowProblem[] = [], sim: SimulationResult | null = null) {
  const counts = new Map<string, { errors: number; warnings: number }>();
  for (const p of problems) {
    if (!p.node) continue;
    const c = counts.get(p.node) ?? { errors: 0, warnings: 0 };
    if (p.severity === "error") c.errors++;
    else c.warnings++;
    counts.set(p.node, c);
  }
  const simOf = new Map<string, { state: SimState; runs: number }>();
  for (const step of sim?.steps ?? []) {
    // Steps of a subflow's child (`<id>.<node>`) light the subflow node.
    const id = step.node.split(".")[0]!;
    const prev = simOf.get(id);
    if (step.kind === "skip") simOf.set(id, { state: "skipped", runs: prev?.runs ?? 0 });
    else simOf.set(id, { state: step.status === "failed" ? "failed" : "succeeded", runs: (prev?.runs ?? 0) + (step.node === id ? 1 : 0) });
  }

  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const chain = view.chain.filter((id) => byId.has(id));
  // The trigger never runs as a step; a dry run that went anywhere started from it.
  const trigger = chain[0] && byId.get(chain[0])?.type === "trigger" ? chain[0] : null;
  if (trigger && sim?.steps.length && !simOf.has(trigger)) simOf.set(trigger, { state: "succeeded", runs: 0 });
  const nodes: StudioNode[] = [];
  const edges: StudioEdge[] = [];
  const rowOf = new Map<string, number>();
  let x = 0;
  let row = 0;
  const place = (width: number) => {
    if (x > 0 && x + width > ROW_WIDTH) {
      row++;
      x = 0;
    }
    return row * (ROW_HEIGHT + ROW_GAP);
  };
  const make = (n: DraftNode, connected: boolean, position: { x: number; y: number }, size = { width: NODE_WIDTH, height: NODE_HEIGHT }): StudioNode => ({
    id: n.id,
    type: n.type,
    label: n.name ?? n.id,
    detail: detailOf(n, view.params),
    parent: n.parent,
    connected,
    errors: counts.get(n.id)?.errors ?? 0,
    warnings: counts.get(n.id)?.warnings ?? 0,
    sim: simOf.get(n.id)?.state ?? null,
    runs: simOf.get(n.id)?.runs ?? 0,
    position,
    ...size,
  });

  const lay = (n: DraftNode, connected: boolean) => {
    if (n.type !== "loop") {
      const y = place(NODE_WIDTH);
      rowOf.set(n.id, row);
      nodes.push(make(n, connected, { x, y: y + LOOP_HEADER + LOOP_PAD }));
      x += NODE_WIDTH + GAP;
      return;
    }
    const count = Math.max(1, n.body.length);
    const width = LOOP_PAD * 2 + count * NODE_WIDTH + (count - 1) * GAP;
    const y = place(width);
    rowOf.set(n.id, row);
    const children = n.body.map((b, i) => make(b, connected, { x: LOOP_PAD + i * (NODE_WIDTH + GAP), y: LOOP_HEADER }));
    const loop = make(n, connected, { x, y }, { width, height: ROW_HEIGHT });
    // A loop ran when its body did; it failed when its last body step failed.
    const bodySim = children.filter((c) => c.sim);
    if (!loop.sim && bodySim.length) loop.sim = bodySim.some((c) => c.sim === "failed") ? "failed" : "succeeded";
    nodes.push(loop, ...children);
    for (let i = 1; i < children.length; i++) edges.push(edge(children[i - 1]!, children[i]!, "flow"));
    if (children.length > 1) edges.push(edge(children.at(-1)!, children[0]!, "loop-back"));
    x += width + GAP;
  };

  for (const id of chain) lay(byId.get(id)!, true);
  const orphans = view.nodes.filter((n) => !chain.includes(n.id));
  if (orphans.length) {
    // Disconnected nodes start a row of their own below the chain.
    if (x > 0) {
      row++;
      x = 0;
    }
    for (const n of orphans) lay(n, false);
  }

  const top = new Map(nodes.filter((n) => !n.parent).map((n) => [n.id, n]));
  for (let i = 1; i < chain.length; i++) {
    const a = top.get(chain[i - 1]!)!;
    const b = top.get(chain[i]!)!;
    edges.push(edge(a, b, "flow", rowOf.get(a.id) !== rowOf.get(b.id)));
  }
  return { nodes, edges };
}

function edge(a: StudioNode, b: StudioNode, kind: StudioEdge["kind"], wrap = false): StudioEdge {
  const simulated = (a.sim === "succeeded" || a.sim === "skipped") && b.sim !== null;
  return { id: `${a.id}->${b.id}${kind === "loop-back" ? ":back" : ""}`, source: a.id, target: b.id, kind, wrap, simulated };
}

/** Every node in the order the arrow keys walk them: the chain with loop bodies, then the rest. */
export function walkOrder(view: DraftView): string[] {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const chain = view.chain.filter((id) => byId.has(id));
  const rest = view.nodes.filter((n) => !chain.includes(n.id)).map((n) => n.id);
  return [...chain, ...rest].flatMap((id) => [id, ...(byId.get(id)?.body.map((b) => b.id) ?? [])]);
}

/** Finds a node, top-level or in a loop body. */
export function findDraftNode(view: DraftView, id: string | null): DraftNode | null {
  if (!id) return null;
  for (const n of view.nodes) {
    if (n.id === id) return n;
    const b = n.body.find((x) => x.id === id);
    if (b) return b;
  }
  return null;
}
