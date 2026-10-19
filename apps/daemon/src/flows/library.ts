import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FLOW_NAME,
  FLOW_YAML_MAX_BYTES,
  SimulationRequest,
  type Actor,
  type FlowCatalogView,
  type FlowDefinition,
  type FlowDetail,
  type FlowProblem,
  type FlowSummary,
  type SaveFlowDraftRequest,
  type SimulationResult,
} from "@navarch/contracts";
import { checkFlow, flowNeeds, KNOWN_USES, NOT_IN_SUBFLOW, parseFlow, simulateFlow, subflowsOf, type FlowCheck, type FlowNeeds } from "@navarch/flow-engine";
import { parseDocument } from "yaml";
import type { EventStore, StudioFlowRecord } from "../events/store.ts";
import { FLOWS_DIR, type FlowLookup, type ResolvedFlow } from "../orchestrator/orchestrator.ts";
import { PROFILES } from "../orchestrator/profiles.ts";
import type { PolicyEngine } from "../policy/engine.ts";

export class FlowStudioError extends Error {
  readonly code: "not_found" | "conflict" | "invalid_request" | "forbidden";
  readonly problems: FlowProblem[];

  constructor(code: FlowStudioError["code"], message: string, problems: FlowProblem[] = []) {
    super(message);
    this.code = code;
    this.problems = problems;
  }
}

type Builtin = { definition: FlowDefinition; text: string };

/** The built-in Flows of a directory with their YAML text, by name. */
export function loadBuiltins(dir: string = FLOWS_DIR): Map<string, Builtin> {
  const out = new Map<string, Builtin>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    const definition = parseFlow(text, `flows/${file}`);
    if (out.has(definition.metadata.name)) throw new Error(`flows/${file}: a flow named ${definition.metadata.name} already exists`);
    out.set(definition.metadata.name, { definition, text });
  }
  const all = new Map([...out].map(([name, b]) => [name, b.definition]));
  for (const flow of all.values()) subflowsOf(flow, all);
  return out;
}

export type FlowLibraryDeps = {
  store: EventStore;
  policy: PolicyEngine;
  adapters: readonly string[];
  autonomyLevel: number;
  builtins?: Map<string, Builtin>;
};

/**
 * Flow Studio's library (ADR 0033): the built-in Flows of `flows/`, read-only, and the Studio
 * Flows of the event store, each with a draft and immutable published versions. Runs get a
 * built-in, else a Studio Flow's latest published version.
 */
export class FlowLibrary implements FlowLookup {
  private readonly deps: FlowLibraryDeps;
  private readonly builtins: Map<string, Builtin>;
  private readonly parsed = new Map<string, FlowDefinition>();

  constructor(deps: FlowLibraryDeps) {
    this.deps = deps;
    this.builtins = deps.builtins ?? loadBuiltins();
  }

  // --- lookup for runs ---

  get(name: string): ResolvedFlow | undefined {
    const builtin = this.builtins.get(name);
    if (builtin) return { definition: builtin.definition, source: "builtin" };
    const row = this.deps.store.studioFlows(name)[0];
    if (!row?.published_version) return undefined;
    return { definition: this.published(name, row.published_version), source: "studio", version: row.published_version };
  }

  all(): ReadonlyMap<string, FlowDefinition> {
    const out = new Map([...this.builtins].map(([name, b]) => [name, b.definition]));
    for (const row of this.deps.store.studioFlows()) {
      if (row.published_version && !out.has(row.name)) out.set(row.name, this.published(row.name, row.published_version));
    }
    return out;
  }

  missing(name: string): string | undefined {
    const row = this.deps.store.studioFlows(name)[0];
    return row && !row.published_version ? `flow "${name}" has only a draft; publish it first` : undefined;
  }

  // --- views ---

  list(): FlowSummary[] {
    const builtins = [...this.builtins.values()].map((b) => this.builtinSummary(b));
    return [...builtins, ...this.deps.store.studioFlows().map((r) => this.studioSummary(r))];
  }

  detail(name: string): FlowDetail {
    const builtin = this.builtins.get(name);
    const row = this.deps.store.studioFlows(name)[0];
    if (builtin && !row) return { ...this.builtinSummary(builtin), draft_yaml: null, published_yaml: builtin.text, based_on: null, versions: [] };
    if (!row) throw new FlowStudioError("not_found", `no flow named "${name}"`);
    const versions = this.deps.store.flowVersions(name);
    return {
      ...this.studioSummary(row),
      draft_yaml: row.draft_yaml,
      published_yaml: versions.at(-1)?.yaml ?? null,
      based_on: row.based_on,
      versions: versions.map(({ version, published_at, actor, sha256 }) => ({ version, published_at, actor, sha256 })),
    };
  }

  versionYaml(name: string, version: number): string {
    const found = this.deps.store.flowVersions(name, version)[0];
    if (!found) throw new FlowStudioError("not_found", `flow "${name}" has no version ${version}`);
    return found.yaml;
  }

  catalog(): FlowCatalogView {
    return {
      profiles: [...PROFILES.values()].map((p) => ({ id: p.id, edits: p.edits })),
      adapters: [...this.deps.adapters],
      uses: { action: [...KNOWN_USES.action], github: [...KNOWN_USES.github] },
      // A subflow's child holds no composite node (ADR 0032).
      flows: [...this.all()].filter(([, f]) => !f.nodes.some((n) => NOT_IN_SUBFLOW.includes(n.type))).map(([name, f]) => ({ name, params: f.params })),
    };
  }

  // --- validation and simulation ---

  /** Every problem of a document, against the profiles, adapters and Flows known now. */
  check(yaml: string, name?: string): FlowCheck {
    if (Buffer.byteLength(yaml) > FLOW_YAML_MAX_BYTES) {
      return { flow: null, problems: [{ severity: "error", message: `a flow is at most ${FLOW_YAML_MAX_BYTES / 1024} KiB` }] };
    }
    const drafts = this.deps.store.studioFlows().filter((r) => !r.published_version).map((r) => r.name);
    const editing = [...PROFILES.values()].filter((p) => p.edits).map((p) => p.id);
    const result = checkFlow(yaml, { profiles: [...PROFILES.keys()], adapters: this.deps.adapters, flows: this.all(), drafts, editing });
    const declared = declaredName(yaml);
    if (name && declared !== undefined && declared !== name) {
      result.problems.unshift({ severity: "error", message: `metadata.name is "${declared}", but this is flow "${name}"; to rename a flow, duplicate it`, path: ["metadata", "name"] });
      return { flow: null, problems: result.problems };
    }
    return result;
  }

  simulate(input: unknown): SimulationResult {
    const req = SimulationRequest.parse(input);
    const { flow, problems } = this.check(req.yaml);
    if (!flow) return { problems, steps: [], end: null };
    const run = simulateFlow(flow, {
      ...(req.params ? { params: req.params } : {}),
      autonomy_level: req.autonomy_level,
      outcomes: req.outcomes,
      subflows: subflowsOf(flow, this.all()),
    });
    return { problems, ...run };
  }

  // --- editing (the user's alone) ---

  saveDraft(name: string, req: SaveFlowDraftRequest, actor: Actor): FlowDetail {
    this.decide(actor, "flow.save", name);
    if (!FLOW_NAME.test(name)) throw new FlowStudioError("invalid_request", "flow names are lowercase letters, digits and -");
    if (this.builtins.has(name)) throw new FlowStudioError("invalid_request", `"${name}" is a built-in flow; duplicate it under another name`);
    if (Buffer.byteLength(req.yaml) > FLOW_YAML_MAX_BYTES) throw new FlowStudioError("invalid_request", `a flow is at most ${FLOW_YAML_MAX_BYTES / 1024} KiB`);
    const declared = declaredName(req.yaml);
    if (declared !== undefined && declared !== name) throw new FlowStudioError("invalid_request", `metadata.name is "${declared}", but this is flow "${name}"; to rename a flow, duplicate it`);
    const row = this.deps.store.studioFlows(name)[0];
    this.expectRevision(row, req.revision);
    this.deps.store.append([
      {
        type: "flow.draft.saved",
        run_id: null,
        task_id: null,
        actor,
        payload: { name, yaml: req.yaml, revision: (row?.draft_revision ?? 0) + 1, based_on: row?.draft_revision ? row.based_on : (row?.published_version ?? null) },
      },
    ]);
    return this.detail(name);
  }

  discardDraft(name: string, revision: number, actor: Actor): FlowDetail | null {
    this.decide(actor, "flow.save", name);
    const row = this.deps.store.studioFlows(name)[0];
    if (!row?.draft_revision) throw new FlowStudioError("not_found", `flow "${name}" has no draft`);
    this.expectRevision(row, revision);
    this.deps.store.append([{ type: "flow.draft.discarded", run_id: null, task_id: null, actor, payload: { name, revision } }]);
    return row.published_version ? this.detail(name) : null;
  }

  publish(name: string, revision: number, actor: Actor): FlowDetail {
    this.decide(actor, "flow.publish", name);
    const row = this.deps.store.studioFlows(name)[0];
    if (!row?.draft_yaml || !row.draft_revision) throw new FlowStudioError("not_found", `flow "${name}" has no draft to publish`);
    this.expectRevision(row, revision);
    const { problems } = this.check(row.draft_yaml, name);
    const errors = problems.filter((p) => p.severity === "error");
    if (errors.length) throw new FlowStudioError("invalid_request", `the draft has ${errors.length} error(s): ${errors[0]!.message}`, problems);
    const version = (row.published_version ?? 0) + 1;
    const sha256 = createHash("sha256").update(row.draft_yaml).digest("hex");
    this.deps.store.append([{ type: "flow.published", run_id: null, task_id: null, actor, payload: { name, version, yaml: row.draft_yaml, sha256, revision } }]);
    return this.detail(name);
  }

  // --- helpers ---

  private published(name: string, version: number): FlowDefinition {
    const key = `${name}@${version}`;
    let flow = this.parsed.get(key);
    if (!flow) {
      flow = parseFlow(this.versionYaml(name, version), `flow ${name} v${version}`);
      this.parsed.set(key, flow);
    }
    return flow;
  }

  private builtinSummary(b: Builtin): FlowSummary {
    const f = b.definition;
    return {
      name: f.metadata.name,
      description: f.metadata.description ?? null,
      source: "builtin",
      published_version: null,
      draft: null,
      node_count: f.nodes.length,
      needs: this.needs(f),
      shadowed: false,
      updated_at: null,
    };
  }

  private studioSummary(row: StudioFlowRecord): FlowSummary {
    const flow = row.published_version ? this.published(row.name, row.published_version) : undefined;
    const description = flow?.metadata.description ?? (row.draft_yaml ? declaredDescription(row.draft_yaml) : undefined) ?? null;
    return {
      name: row.name,
      description,
      source: "studio",
      published_version: row.published_version,
      draft: row.draft_revision && row.draft_saved_at ? { revision: row.draft_revision, saved_at: row.draft_saved_at } : null,
      node_count: flow ? flow.nodes.length : null,
      needs: flow ? this.needs(flow) : null,
      shadowed: this.builtins.has(row.name),
      updated_at: row.updated_at,
    };
  }

  /** Subflows count when they resolve; one that no longer does leaves the run to report it. */
  private needs(flow: FlowDefinition): Exclude<FlowNeeds, "merged_pull_request"> {
    let subflows: Record<string, FlowDefinition> = {};
    try {
      subflows = subflowsOf(flow, this.all());
    } catch {
      // The run refuses it with the reason when started.
    }
    const needs = flowNeeds(flow, subflows);
    // The pickers say "needs a pull request" for both; a merged one is chosen with the same --pr (ADR 0049).
    return needs === "merged_pull_request" ? "pull_request" : needs;
  }

  private expectRevision(row: StudioFlowRecord | undefined, revision: number | null): void {
    const current = row?.draft_revision ?? null;
    if (current !== revision) {
      throw new FlowStudioError("conflict", current === null ? "the draft was published or discarded since you loaded it; reload" : `the draft is at revision ${current}, not ${revision}; reload to see the newer one`);
    }
  }

  private decide(actor: Actor, action: string, name: string): void {
    const decision = this.deps.policy.decide(actor, action, `flow:${name}`, { autonomyLevel: this.deps.autonomyLevel });
    if (decision.effect !== "allow") throw new FlowStudioError("forbidden", `${action} denied: ${decision.reason}`);
  }
}

function rawMetadata(yaml: string): { name?: unknown; description?: unknown } | undefined {
  const doc = parseDocument(yaml);
  if (doc.errors.length) return undefined;
  const raw = doc.toJS() as { metadata?: { name?: unknown; description?: unknown } } | null;
  return raw?.metadata ?? undefined;
}

function declaredName(yaml: string): string | undefined {
  const name = rawMetadata(yaml)?.name;
  return typeof name === "string" ? name : undefined;
}

function declaredDescription(yaml: string): string | undefined {
  const d = rawMetadata(yaml)?.description;
  return typeof d === "string" ? d : undefined;
}
