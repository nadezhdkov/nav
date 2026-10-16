import { FlowDefinition, joinNeeds, PHASE_2_NODE_TYPES, type BodyNode, type FlowNode, type FlowProblem } from "@navarch/contracts";
import { isNode, LineCounter, parseDocument, type Document } from "yaml";
import { exprPaths, isExpression, parseExpr } from "./expr.ts";

/** Operations an `action` or `github` node may name; the daemon registers an executor for each. */
export const KNOWN_USES: Record<"action" | "github", readonly string[]> = {
  action: ["verification.run"],
  github: ["pr.create", "pr.review", "pr.comment"],
};

/** What a Flow may name, from the daemon; a check is skipped when its list is not given. */
export type FlowCatalog = {
  profiles?: readonly string[];
  adapters?: readonly string[];
  /** Flows a `subflow` node may run: the built-ins and the published Studio Flows. */
  flows?: ReadonlyMap<string, FlowDefinition>;
  /** Studio Flows that have only a draft. */
  drafts?: readonly string[];
  /** Profiles that edit the worktree; a parallel branch may not use them (ADR 0036). */
  editing?: readonly string[];
};

export type FlowCheck = { flow: FlowDefinition | null; problems: FlowProblem[] };

type Path = (string | number)[];

/** Node types a subflow's child may not hold: one level, and no composite nodes (ADR 0032). */
export const NOT_IN_SUBFLOW = ["team", "compete", "subflow"];

/** Fields that hold a count, so a param they read must be an `int`. */
const COUNT_FIELDS = ["max_iterations", "max_turns", "max_members", "max_parallel", "competitors", "max_fix_iterations"];

/**
 * Every problem of a Flow YAML document (spec §6.2.3, ADR 0033), each with its node, path and
 * line when known. Errors block publishing; `flow` is the parsed Flow only when there are none.
 */
export function checkFlow(text: string, catalog: FlowCatalog = {}): FlowCheck {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  const problems: FlowProblem[] = [];
  const lineOf = (path: Path) => lineAt(doc, lines, path);
  if (doc.errors.length) {
    for (const err of doc.errors) {
      problems.push({ severity: "error", message: `invalid YAML: ${err.message.split("\n")[0]}`, line: lines.linePos(err.pos[0]).line });
    }
    return { flow: null, problems };
  }
  const raw = doc.toJS() as unknown;
  const later = laterNodeType(raw);
  if (later) {
    const message = later.type === "join" ? `node type "join" does not exist on its own: a parallel node's \`join\` field (all, any, quorum:N) says how its branches join` : `node type "${later.type}" is not supported yet`;
    problems.push({ severity: "error", message, path: later.path, line: lineOf(later.path) });
    return { flow: null, problems };
  }
  const parsed = FlowDefinition.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.filter((p): p is string | number => typeof p !== "symbol");
      problems.push({ severity: "error", message: `${path.join(".") || "flow"}: ${issue.message}`, path, line: lineOf(path), ...nodeAt(raw, path) });
    }
    return { flow: null, problems };
  }
  const flow = parsed.data;
  checkStructure(flow, catalog, (severity, message, at = {}) => {
    const path = at.path ?? (at.node ? nodePath(flow, at.node) : undefined);
    problems.push({ severity, message, ...(at.node ? { node: at.node } : {}), ...(path ? { path, line: lineOf(path) } : {}) });
  });
  return { flow: problems.some((p) => p.severity === "error") ? null : flow, problems };
}

type Report = (severity: FlowProblem["severity"], message: string, at?: { node?: string; path?: Path }) => void;

function checkStructure(flow: FlowDefinition, catalog: FlowCatalog, report: Report): void {
  const error = (message: string, at?: { node?: string; path?: Path }) => report("error", message, at);
  const all = flow.nodes.flatMap((n): (FlowNode | BodyNode)[] => [n, ...innerNodes(n)]);
  const ids = new Set<string>();
  for (const n of all) {
    if (ids.has(n.id)) error(`duplicate node id "${n.id}"`, { path: nodePath(flow, n.id, true) });
    ids.add(n.id);
  }

  // One linear chain naming every top-level node once.
  const seen: string[] = [];
  flow.edges.forEach((edge, i) => {
    const order = edge.split("->").map((s) => s.trim());
    if (order.some((id) => !id)) return error("edges must look like `a -> b -> c`", { path: ["edges", i] });
    for (const id of order) {
      if (!flow.nodes.some((n) => n.id === id)) {
        error(`edge names unknown top-level node "${id}"`, { path: ["edges", i] });
        continue;
      }
      if (seen.at(-1) === id) continue;
      if (seen.includes(id)) {
        error(`node "${id}" appears twice in edges: a cycle; repeat steps with a loop node`, { path: ["edges", i] });
        continue;
      }
      seen.push(id);
    }
  });
  for (const n of flow.nodes) if (!seen.includes(n.id)) error(`node "${n.id}" is not in edges`, { node: n.id });
  const triggers = flow.nodes.filter((n) => n.type === "trigger");
  if (triggers.length > 1 || (triggers.length === 1 && seen[0] !== triggers[0]!.id)) error("a flow has at most one trigger, and it comes first", { node: triggers.at(-1)!.id });

  // What each node may read: the nodes before it in the chain, and its own loop's body.
  const before = new Map<string, Set<string>>();
  const done = new Set<string>();
  for (const id of seen) {
    const node = flow.nodes.find((n) => n.id === id)!;
    const body = node.type === "loop" ? node.body.map((b) => b.id) : [];
    const visible = new Set([...done, ...body]);
    before.set(id, visible);
    for (const b of body) before.set(b, visible);
    // A branch node sees what came before the parallel node and the earlier nodes of its own branch.
    if (node.type === "parallel") {
      for (const nodes of Object.values(node.branches)) {
        nodes.forEach((b, i) => before.set(b.id, new Set([...done, ...nodes.slice(0, i).map((x) => x.id)])));
      }
    }
    done.add(id);
    for (const b of innerNodes(node)) done.add(b.id);
  }

  for (const n of all) {
    const at = (...field: Path) => ({ node: n.id, path: [...nodePath(flow, n.id), ...field] });
    if ((n.type === "action" || n.type === "github") && !KNOWN_USES[n.type].includes(n.uses)) {
      error(`node "${n.id}": unknown ${n.type} "${n.uses}" (known: ${KNOWN_USES[n.type].join(", ")})`, at("uses"));
    }
    const profiles: [string, Path][] = n.type === "agent" ? [[n.profile, ["profile"]]] : n.type === "team" ? [[n.lead.profile, ["lead", "profile"]]] : n.type === "compete" ? [[n.judge.profile, ["judge", "profile"]]] : [];
    if (n.type === "agent" && n.adapter && catalog.adapters && !catalog.adapters.includes(n.adapter)) {
      error(`node "${n.id}": unknown adapter "${n.adapter}" (known: ${catalog.adapters.join(", ")})`, at("adapter"));
    }
    for (const [profile, field] of profiles) {
      if (catalog.profiles && !catalog.profiles.includes(profile)) error(`node "${n.id}": unknown agent profile "${profile}" (known: ${catalog.profiles.join(", ")})`, at(...field));
    }
    if (n.type === "parallel") {
      const count = Object.keys(n.branches).length;
      if (joinNeeds(n.join, count) > count) error(`node "${n.id}": join ${n.join} needs more branches than its ${count}`, at("join"));
      for (const [key, nodes] of Object.entries(n.branches)) {
        nodes.forEach((b, j) => {
          if (b.type === "agent" && catalog.editing?.includes(b.profile)) {
            error(`node "${b.id}": profile "${b.profile}" edits the worktree, and parallel branches run read-only agents; edit in parallel with a team or compete node`, { node: b.id, path: [...nodePath(flow, n.id), "branches", key, j, "profile"] });
          }
        });
      }
    }
    if (n.type === "subflow" && catalog.flows) checkSubflow(n, catalog, (m, field) => error(`node "${n.id}": ${m}`, at(...field)));

    for (const [text, field] of expressionsOf(n)) {
      let expr;
      try {
        expr = parseExpr(text);
      } catch (err) {
        error(`node "${n.id}": ${(err as Error).message}`, at(...field));
        continue;
      }
      for (const path of exprPaths(expr)) {
        const [root, name] = path;
        if (root === "nodes") {
          if (!ids.has(name ?? "")) error(`node "${n.id}" refers to unknown node "${name}"`, at(...field));
          else if (name === n.id && !before.get(n.id)?.has(n.id)) error(`node "${n.id}" reads its own outputs before it runs`, at(...field));
          else if (before.has(n.id) && !before.get(n.id)!.has(name!) && name !== n.id) error(`node "${n.id}" reads "${name}", which runs later`, at(...field));
        }
        if (root === "params") {
          const param = flow.params[name!];
          if (!param) error(`node "${n.id}" refers to unknown param "${name}"`, at(...field));
          else if (COUNT_FIELDS.includes(String(field[0])) && !expr.op && param.type !== "int") {
            error(`node "${n.id}": param "${name}" is a ${param.type}, and ${field[0]} needs an int`, at(...field));
          }
        }
      }
    }
  }

  // Warnings: never block publishing.
  const workers = new Set(["agent", "team", "compete", "subflow", "parallel"]);
  if (!all.some((n) => workers.has(n.type))) report("warning", "the flow has no agent, team, compete or subflow node, so nothing would do the work");
  for (const id of seen) {
    const n = flow.nodes.find((x) => x.id === id)!;
    if (n.type !== "github" || n.uses !== "pr.create") continue;
    const earlier = [...(before.get(id) ?? [])].map((x) => all.find((a) => a.id === x)!);
    if (!earlier.some((x) => workers.has(x.type))) report("warning", `node "${id}" opens a PR, but nothing before it edits`, { node: id });
  }
}

function checkSubflow(node: Extract<FlowNode, { type: "subflow" }>, catalog: FlowCatalog, error: (message: string, field: Path) => void): void {
  const child = catalog.flows!.get(node.flow);
  if (!child) {
    if (catalog.drafts?.includes(node.flow)) return error(`flow "${node.flow}" has no published version; publish it first`, ["flow"]);
    return error(`unknown flow "${node.flow}" (known: ${[...catalog.flows!.keys()].join(", ")})`, ["flow"]);
  }
  const nested = child.nodes.find((n) => NOT_IN_SUBFLOW.includes(n.type));
  if (nested) error(`flow "${node.flow}" cannot hold team, compete or subflow nodes, and has ${nested.type} "${nested.id}"`, ["flow"]);
  for (const name of Object.keys(node.with ?? {})) {
    if (!(name in child.params)) error(`flow "${node.flow}" has no param "${name}"`, ["with", name]);
  }
}

/** Every expression of a node, with the field it is in. */
function expressionsOf(n: FlowNode | BodyNode): [string, Path][] {
  const out: [string, Path][] = [];
  if (n.when) out.push([n.when, ["when"]]);
  const fields = (obj: Record<string, unknown>, names: string[]) => {
    for (const name of names) if (typeof obj[name] === "string") out.push([obj[name] as string, [name]]);
  };
  if (n.type === "agent") for (const [k, v] of Object.entries(n.inputs ?? {})) if (isExpression(v)) out.push([v, ["inputs", k]]);
  if (n.type === "loop") fields(n, ["until", "max_iterations"]);
  if (n.type === "approval") (n.show ?? []).forEach((p, i) => out.push([`\${{ ${p} }}`, ["show", i]]));
  if (n.type === "team") fields(n, ["max_turns", "max_members", "approve_first_plan", "parallel", "max_parallel"]);
  if (n.type === "compete") fields(n, ["competitors", "max_fix_iterations", "approve_pick"]);
  if (n.type === "subflow") {
    for (const key of ["with", "inputs"] as const) {
      for (const [k, v] of Object.entries(n[key] ?? {})) if (typeof v === "string" && isExpression(v)) out.push([v, [key, k]]);
    }
  }
  return out;
}

function laterNodeType(raw: unknown): { type: string; path: Path } | undefined {
  const nodes = (raw as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) return undefined;
  const later = (n: unknown) => [...PHASE_2_NODE_TYPES, "join"].includes((n as { type?: string })?.type ?? "");
  for (const [i, n] of nodes.entries()) {
    if (later(n)) return { type: n.type, path: ["nodes", i] };
    for (const [j, b] of (Array.isArray(n?.body) ? n.body : []).entries()) if (later(b)) return { type: b.type, path: ["nodes", i, "body", j] };
    const branches = n?.branches && typeof n.branches === "object" ? Object.entries(n.branches as Record<string, unknown>) : [];
    for (const [key, list] of branches) {
      for (const [j, b] of (Array.isArray(list) ? list : []).entries()) if (later(b)) return { type: b.type, path: ["nodes", i, "branches", key, j] };
    }
  }
  return undefined;
}

/** A node's loop body or parallel branches. */
export function innerNodes(n: FlowNode): BodyNode[] {
  return n.type === "loop" ? n.body : n.type === "parallel" ? Object.values(n.branches).flat() : [];
}

/** The YAML path of a node, top-level, in a loop body or in a parallel branch; the last one with the id when `last`. */
function nodePath(flow: FlowDefinition, id: string, last = false): Path {
  const found: Path[] = [];
  flow.nodes.forEach((n, i) => {
    if (n.id === id) found.push(["nodes", i]);
    if (n.type === "loop") n.body.forEach((b, j) => b.id === id && found.push(["nodes", i, "body", j]));
    if (n.type === "parallel") for (const [key, nodes] of Object.entries(n.branches)) nodes.forEach((b, j) => b.id === id && found.push(["nodes", i, "branches", key, j]));
  });
  return (last ? found.at(-1) : found[0]) ?? [];
}

/** The node a schema issue is in, from the raw document. */
function nodeAt(raw: unknown, path: Path): { node?: string } {
  if (path[0] !== "nodes" || typeof path[1] !== "number") return {};
  let n = (raw as { nodes: unknown[] }).nodes[path[1]] as { id?: unknown; body?: unknown[]; branches?: Record<string, unknown[]> } | undefined;
  if (path[2] === "body" && typeof path[3] === "number") n = n?.body?.[path[3]] as typeof n;
  else if (path[2] === "branches" && typeof path[3] === "string" && typeof path[4] === "number") n = n?.branches?.[path[3]]?.[path[4]] as typeof n;
  return typeof n?.id === "string" ? { node: n.id } : {};
}

/** The line of the deepest part of `path` the document has. */
function lineAt(doc: Document, lines: LineCounter, path: Path): number | undefined {
  for (let p = path; ; p = p.slice(0, -1)) {
    const node = p.length ? doc.getIn(p, true) : doc.contents;
    if (isNode(node) && node.range) return lines.linePos(node.range[0]).line;
    if (!p.length) return undefined;
  }
}
