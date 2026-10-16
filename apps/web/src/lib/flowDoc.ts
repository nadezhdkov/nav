import { isMap, isScalar, isSeq, parseDocument, visit, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { lineDiff } from "./lineDiff.ts";

/**
 * Flow Studio's document model (ADR 0033). The YAML text is the source of truth: every visual
 * edit parses it, changes only what the gesture concerns through the `yaml` Document, and writes
 * back just the lines that changed, so comments, key order and formatting elsewhere stay as written.
 * This is editing, not validation: the daemon checks the result (`POST /api/v1/flows/validate`).
 */

export const NODE_TYPES = ["agent", "action", "approval", "loop", "github", "subflow", "team", "compete", "trigger"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** One node as the canvas sees it, whatever its state: missing fields are simply absent. */
export type DraftNode = {
  id: string;
  type: string;
  name?: string;
  /** The loop a body node belongs to. */
  parent: string | null;
  /** Every field as written, for the properties panel. */
  raw: Record<string, unknown>;
  body: DraftNode[];
};

export type DraftParam = { type: string; default: unknown };

export type DraftView = {
  name: string | null;
  description: string | null;
  params: Record<string, DraftParam>;
  /** Top-level nodes in document order, with their loop bodies. */
  nodes: DraftNode[];
  /** Top-level ids in `edges` order. */
  chain: string[];
};

const STRINGIFY = { lineWidth: 0 } as const;

/** The document's nodes, chain and metadata, or null when the YAML does not parse. */
export function readDraft(text: string): DraftView | null {
  const doc = parseDocument(text);
  if (doc.errors.length) return null;
  const js = (doc.toJS() ?? {}) as Record<string, unknown>;
  const meta = (isObject(js.metadata) ? js.metadata : {}) as Record<string, unknown>;
  const params: Record<string, DraftParam> = {};
  if (isObject(js.params)) {
    for (const [k, v] of Object.entries(js.params)) params[k] = { type: String((v as Record<string, unknown>)?.type ?? ""), default: (v as Record<string, unknown>)?.default };
  }
  const toNode = (raw: unknown, parent: string | null): DraftNode | null => {
    if (!isObject(raw) || typeof raw.id !== "string") return null;
    const node: DraftNode = { id: raw.id, type: String(raw.type ?? ""), parent, raw, body: [] };
    if (typeof raw.name === "string") node.name = raw.name;
    if (Array.isArray(raw.body)) node.body = raw.body.map((b) => toNode(b, node.id)).filter((b): b is DraftNode => b !== null);
    return node;
  };
  const nodes = (Array.isArray(js.nodes) ? js.nodes : []).map((n) => toNode(n, null)).filter((n): n is DraftNode => n !== null);
  return {
    name: typeof meta.name === "string" ? meta.name : null,
    description: typeof meta.description === "string" ? meta.description : null,
    params,
    nodes,
    chain: chainOf(js.edges),
  };
}

/** `edges` as one ordered list of ids: `a -> b -> c`, possibly over several strings. */
export function chainOf(edges: unknown): string[] {
  const order: string[] = [];
  for (const line of Array.isArray(edges) ? edges : []) {
    if (typeof line !== "string") continue;
    for (const id of line.split("->").map((s) => s.trim())) if (id && order.at(-1) !== id) order.push(id);
  }
  return order;
}

/**
 * Applies an edit to the document and returns the new text, keeping every line the edit did not
 * touch byte for byte. Throws when the text does not parse: the YAML view must be fixed first.
 */
export function edit(text: string, change: (doc: Document) => void): string {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error("the YAML does not parse; fix it in the YAML view first");
  const before = doc.toString(STRINGIFY);
  change(doc);
  const after = doc.toString(STRINGIFY);
  if (after === before) return text;
  const original = text.split("\n");
  // The library normalizes some spacing (e.g. `[ a ]`); keep the original form of lines the edit left alone.
  if (before.split("\n").length !== original.length) return after;
  return lineDiff(before, after)
    .filter((d) => d.kind !== "del")
    .map((d) => (d.kind === "same" ? original[d.a!]! : d.text))
    .join("\n");
}

// --- operations, each `(doc) => void` for `edit` ---

/** Sets a field of a node (`path` inside the node), or removes it for `undefined` or "". */
export function setField(id: string, path: (string | number)[], value: unknown) {
  return (doc: Document) => {
    const node = findNode(doc, id);
    if (!node) throw new Error(`no node "${id}"`);
    if (value === undefined || value === "") node.map.deleteIn(path);
    else node.map.setIn(path, doc.createNode(value));
  };
}

/** Sets `metadata.<field>`, or removes it. */
export function setMeta(field: "name" | "description", value: string | undefined) {
  return (doc: Document) => {
    if (value === undefined || value === "") doc.deleteIn(["metadata", field]);
    else doc.setIn(["metadata", field], value);
  };
}

/** Adds, changes (`name` and `param`) or removes (`param` null) a Flow param. */
export function setParam(name: string, param: DraftParam | null) {
  return (doc: Document) => {
    if (param === null) {
      doc.deleteIn(["params", name]);
      const params = doc.get("params");
      if (isMap(params) && params.items.length === 0) doc.delete("params");
      return;
    }
    if (!doc.has("params")) {
      const params = doc.createNode({}) as YAMLMap;
      // Params go before nodes, as in the built-in Flows.
      const root = doc.contents as YAMLMap;
      const at = root.items.findIndex((p) => isScalar(p.key) && p.key.value === "nodes");
      root.items.splice(at < 0 ? root.items.length : at, 0, doc.createPair("params", params));
    }
    const node = doc.createNode({ type: param.type, default: param.default }) as YAMLMap;
    node.flow = true;
    doc.setIn(["params", name], node);
  };
}

/**
 * Adds a node of `type` after the node `after` (in its loop body when it is a body node), or at
 * the end. A top-level node joins the chain unless `connect` is false: it then stays disconnected
 * until the user connects it. A trigger always goes first. Returns the new node's id through `out`.
 */
export function addNode(type: NodeType, after: string | null, connect = true, out: { id?: string } = {}) {
  return (doc: Document) => {
    const ids = new Set(allIds(doc));
    const unique = (base: string) => {
      let id = base;
      for (let i = 2; ids.has(id); i++) id = `${base}_${i}`;
      ids.add(id);
      return id;
    };
    const template = templateFor(type, unique);
    out.id = template.id as string;
    const node = doc.createNode(template) as YAMLMap;
    const anchor = after ? findNode(doc, after) : undefined;
    if (anchor?.parent) {
      if (type === "loop" || type === "trigger" || type === "team" || type === "compete" || type === "subflow" || type === "approval" || type === "github") {
        throw new Error(`a ${type} node cannot go inside a loop`);
      }
      anchor.seq.items.splice(anchor.index + 1, 0, node);
      return;
    }
    const nodes = ensureSeq(doc, "nodes");
    const at = type === "trigger" ? 0 : anchor ? anchor.index + 1 : nodes.items.length;
    node.spaceBefore = nodes.items.some((n) => isMap(n) && n.spaceBefore);
    nodes.items.splice(at, 0, node);
    if (!connect) return;
    const chain = chainOf(doc.toJS().edges);
    const pos = type === "trigger" ? 0 : anchor ? chain.indexOf(anchor.id) + 1 || chain.length : chain.length;
    chain.splice(pos, 0, out.id);
    setChain(doc, chain);
  };
}

/** Removes a node, its loop body included, and closes the chain over the gap. */
export function removeNode(id: string) {
  return (doc: Document) => {
    const found = findNode(doc, id);
    if (!found) return;
    found.seq.items.splice(found.index, 1);
    if (!found.parent) {
      const chain = chainOf(doc.toJS().edges);
      if (chain.includes(id)) setChain(doc, chain.filter((x) => x !== id));
    }
  };
}

/** Puts `target` right after `source` in the chain (a drag from source's output to target). */
export function connect(source: string, target: string) {
  return (doc: Document) => {
    if (source === target) return;
    const src = findNode(doc, source);
    const dst = findNode(doc, target);
    if (!src || !dst || src.parent || dst.parent) throw new Error("only top-level nodes are connected; a loop's body runs in order");
    if (dst.type === "trigger") throw new Error("the trigger comes first; nothing runs before it");
    const chain = chainOf(doc.toJS().edges).filter((x) => x !== target);
    if (!chain.includes(source)) chain.push(source);
    chain.splice(chain.indexOf(source) + 1, 0, target);
    setChain(doc, chain);
  };
}

/**
 * Puts a top-level node in the chain right after `after`, or first (after the trigger, if any)
 * when `after` is null: the keyboard way to connect a node.
 */
export function placeAfter(id: string, after: string | null) {
  return (doc: Document) => {
    if (after !== null) return connect(after, id)(doc);
    const chain = chainOf(doc.toJS().edges).filter((x) => x !== id);
    const first = findNode(doc, chain[0] ?? "");
    chain.splice(first?.type === "trigger" ? 1 : 0, 0, id);
    setChain(doc, chain);
  };
}

/** Takes a node out of the chain without deleting it. */
export function disconnect(id: string) {
  return (doc: Document) => {
    const chain = chainOf(doc.toJS().edges);
    if (chain.includes(id)) setChain(doc, chain.filter((x) => x !== id));
  };
}

/** Moves a top-level node one step earlier (-1) or later (+1) in the chain, or a body node in its loop. */
export function moveNode(id: string, by: -1 | 1) {
  return (doc: Document) => {
    const found = findNode(doc, id);
    if (!found) return;
    if (found.parent) {
      const to = found.index + by;
      if (to < 0 || to >= found.seq.items.length) return;
      const [item] = found.seq.items.splice(found.index, 1);
      found.seq.items.splice(to, 0, item);
      return;
    }
    const chain = chainOf(doc.toJS().edges);
    const i = chain.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= chain.length) return;
    [chain[i], chain[j]] = [chain[j]!, chain[i]!];
    setChain(doc, chain);
  };
}

/** Renames a node: its id, its place in the chain, and `nodes.<id>` in every expression. */
export function renameNode(id: string, to: string) {
  return (doc: Document) => {
    if (id === to) return;
    if (!/^[a-z][a-z0-9_]*$/.test(to)) throw new Error("node ids are lowercase letters, digits and _");
    if (allIds(doc).includes(to)) throw new Error(`a node "${to}" already exists`);
    const found = findNode(doc, id);
    if (!found) return;
    found.map.set("id", to);
    const ref = new RegExp(`(\\bnodes\\.)${id}\\b`, "g");
    visit(doc, {
      Scalar(_key, node) {
        if (typeof node.value === "string" && node.value.includes("nodes.")) node.value = node.value.replace(ref, `$1${to}`);
      },
    });
    const chain = chainOf(doc.toJS().edges);
    if (chain.includes(id)) setChain(doc, chain.map((x) => (x === id ? to : x)));
  };
}

// --- helpers ---

type Found = { map: YAMLMap; seq: YAMLSeq; index: number; parent: string | null; id: string; type: string };

function findNode(doc: Document, id: string): Found | undefined {
  const nodes = doc.get("nodes");
  if (!isSeq(nodes)) return undefined;
  for (const [index, item] of nodes.items.entries()) {
    if (!isMap(item)) continue;
    if (item.get("id") === id) return { map: item, seq: nodes, index, parent: null, id, type: String(item.get("type")) };
    const body = item.get("body");
    if (!isSeq(body)) continue;
    for (const [j, b] of body.items.entries()) {
      if (isMap(b) && b.get("id") === id) return { map: b, seq: body, index: j, parent: String(item.get("id")), id, type: String(b.get("type")) };
    }
  }
  return undefined;
}

function allIds(doc: Document): string[] {
  const view = readDraft(doc.toString(STRINGIFY));
  return (view?.nodes ?? []).flatMap((n) => [n.id, ...n.body.map((b) => b.id)]);
}

function ensureSeq(doc: Document, key: string): YAMLSeq {
  const found = doc.get(key);
  if (isSeq(found)) return found;
  const seq = doc.createNode([]) as YAMLSeq;
  doc.set(key, seq);
  return seq;
}

/** Writes the chain as one `a -> b -> c` string, keeping the `edges` sequence and its style. */
function setChain(doc: Document, chain: string[]): void {
  const line = chain.join(" -> ");
  const edges = doc.get("edges");
  if (isSeq(edges) && edges.items.length && isScalar(edges.items[0])) {
    if (!chain.length) {
      edges.items.splice(0);
      edges.flow = true;
      return;
    }
    (edges.items[0] as { value: unknown }).value = line;
    edges.items.splice(1);
    return;
  }
  doc.set("edges", doc.createNode(chain.length ? [line] : []));
}

function templateFor(type: NodeType, unique: (base: string) => string): Record<string, unknown> {
  switch (type) {
    case "agent":
      return { id: unique("implement"), type, profile: "implementer" };
    case "action":
      return { id: unique("verify"), type, uses: "verification.run" };
    case "approval":
      return { id: unique("approve"), type };
    case "github":
      return { id: unique("open_pr"), type, uses: "pr.create", with: { draft: true } };
    case "loop": {
      const id = unique("fix_loop");
      const implement = unique("implement");
      const verify = unique("verify");
      return {
        id,
        type,
        max_iterations: 3,
        until: `\${{ nodes.${verify}.outputs.passed }}`,
        body: [
          { id: implement, type: "agent", profile: "implementer" },
          { id: verify, type: "action", uses: "verification.run" },
        ],
      };
    }
    case "team":
      return { id: unique("team"), type, lead: { profile: "lead" }, max_turns: 8 };
    case "compete":
      return { id: unique("compete"), type, competitors: 3, judge: { profile: "judge" } };
    case "subflow":
      return { id: unique("sub"), type, flow: "task" };
    case "trigger":
      return { id: unique("start"), type };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A new Flow's first document: one implementer, connected. */
export function newFlowYaml(name: string): string {
  return `apiVersion: navarch/v1
kind: Flow
metadata:
  name: ${name}
  description: ""
nodes:
  - id: implement
    type: agent
    profile: implementer
edges:
  - implement
`;
}

/** A copy of another Flow under a new name. */
export function duplicateYaml(text: string, name: string): string {
  return edit(text, setMeta("name", name));
}
