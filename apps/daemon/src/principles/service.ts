import { MAX_PENDING_PROPOSALS, MAX_PRINCIPLES, newId, parsePrincipleProposals, PROPOSING_PROFILES, type Actor, type AddPrincipleRequest, type NewEvent, type PrincipleView, type PrinciplesView } from "@navarch/contracts";
import { readFileAtCommit } from "@navarch/runner";
import type { EventStore } from "../events/store.ts";
import type { PolicyEngine } from "../policy/engine.ts";

export const PRINCIPLES_FILE = ".navarch/principles.md";

export class PrinciplesError extends Error {
  readonly code: "not_found" | "forbidden" | "invalid";

  constructor(code: PrinciplesError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The rules of a repository: one per bullet line of `.navarch/principles.md`. Headings, prose and
 * nested bullets are not rules; a line over 300 characters is cut, an empty bullet is skipped.
 */
export function parsePrinciplesFile(text: string): string[] {
  const rules: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^[-*+]\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const rule = m[1]!.replace(/\s+/g, " ");
    if (rule.length >= 3) rules.push(rule.slice(0, 300));
  }
  return rules;
}

type Deps = { store: EventStore; policy: PolicyEngine; autonomyLevel: number };

/**
 * Project memory (spec §6.8.3, ADR 0047). A rule is the user's approved one (events, `principles.set`
 * is the user's only) or a bullet of the repository's own `.navarch/principles.md`, read at the run's
 * base commit like `project.yaml`, so an agent cannot rewrite the rules that bind it.
 */
export class PrinciplesService {
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  /** The rules for a project: the user's first, then the file's, at most `MAX_PRINCIPLES`. */
  async view(projectId: string): Promise<PrinciplesView> {
    const project = this.deps.store.getProject(projectId);
    if (!project || project.removed_at) throw new PrinciplesError("not_found", `project ${projectId} not found`);
    return this.compose(projectId, await fileRules(project.path, "HEAD"));
  }

  /** The rules a run's agents get: the file at the run's base commit plus the user's list. */
  async forRun(run: { repo_path: string; base_commit: string }): Promise<string[]> {
    const project = this.deps.store.projectByPath(run.repo_path);
    const file = await fileRules(run.repo_path, run.base_commit);
    if (!project) return file.slice(0, MAX_PRINCIPLES);
    return this.compose(project.id, file).principles.map((p) => p.text);
  }

  add(projectId: string, req: AddPrincipleRequest, actor: Actor): PrincipleView {
    this.allow(actor, projectId);
    const project = this.deps.store.getProject(projectId);
    if (!project || project.removed_at) throw new PrinciplesError("not_found", `project ${projectId} not found`);
    const existing = this.deps.store.principles(projectId);
    if (existing.some((p) => p.text.toLowerCase() === req.text.toLowerCase())) throw new PrinciplesError("invalid", "that rule is already in the list");
    if (existing.length >= MAX_PRINCIPLES) throw new PrinciplesError("invalid", `a project keeps at most ${MAX_PRINCIPLES} rules; remove one first`);
    if (req.run_id && !this.deps.store.getRun(req.run_id)) throw new PrinciplesError("invalid", `run ${req.run_id} not found`);
    const id = newId("prin");
    this.deps.store.append([{ type: "principle.added", run_id: req.run_id ?? null, task_id: null, actor, payload: { project_id: projectId, principle_id: id, text: req.text, run_id: req.run_id ?? null } }]);
    const added = this.deps.store.principles(projectId).find((p) => p.id === id)!;
    return { id, text: added.text, source: "user", added_at: added.added_at, run_id: added.run_id };
  }

  remove(projectId: string, principleId: string, actor: Actor): void {
    this.allow(actor, projectId);
    if (!this.deps.store.principles(projectId).some((p) => p.id === principleId)) throw new PrinciplesError("not_found", `rule ${principleId} not found`);
    this.deps.store.append([{ type: "principle.removed", run_id: null, task_id: null, actor, payload: { project_id: projectId, principle_id: principleId } }]);
  }

  /**
   * The proposals in a finished agent's summary (ADR 0056), as events: only planner and reviewer
   * summaries count, only for a run in a registered project, and a rule the project already has,
   * waits for or dismissed is not proposed again. A proposal is text from an agent that read
   * untrusted code and issues; nothing applies it until the user accepts it.
   */
  proposalsFrom(run: { id: string; repo_path: string }, task: { id: string; profile: string }, summary: string): NewEvent[] {
    if (!PROPOSING_PROFILES.includes(task.profile)) return [];
    const { rules } = parsePrincipleProposals(summary);
    if (!rules.length) return [];
    const project = this.deps.store.projectByPath(run.repo_path);
    if (!project) return [];
    const known = new Set([...this.deps.store.principles(project.id).map((p) => p.text), ...this.deps.store.principleProposals(project.id).map((p) => p.text)].map((t) => t.toLowerCase()));
    let pending = this.deps.store.principleProposals(project.id, "pending").length;
    const events: NewEvent[] = [];
    for (const rule of rules) {
      if (pending >= MAX_PENDING_PROPOSALS) break;
      if (known.has(rule.text.toLowerCase())) continue;
      known.add(rule.text.toLowerCase());
      pending++;
      events.push({
        type: "principle.proposed",
        run_id: run.id,
        task_id: task.id,
        actor: { kind: "agent", profile: task.profile, adapter: "unknown" },
        payload: { project_id: project.id, proposal_id: newId("prop"), text: rule.text, reason: rule.reason, run_id: run.id, task_id: task.id },
      });
    }
    return events;
  }

  /** The user accepts a proposal: it becomes one of the project's rules. */
  accept(projectId: string, proposalId: string, actor: Actor): PrincipleView {
    this.allow(actor, projectId);
    const proposal = this.pending(projectId, proposalId);
    const existing = this.deps.store.principles(projectId);
    if (existing.some((p) => p.text.toLowerCase() === proposal.text.toLowerCase())) throw new PrinciplesError("invalid", "that rule is already in the list");
    if (existing.length >= MAX_PRINCIPLES) throw new PrinciplesError("invalid", `a project keeps at most ${MAX_PRINCIPLES} rules; remove one first`);
    const id = newId("prin");
    this.deps.store.append([
      { type: "principle.added", run_id: proposal.run_id, task_id: null, actor, payload: { project_id: projectId, principle_id: id, text: proposal.text, run_id: proposal.run_id } },
      { type: "principle.proposal.decided", run_id: proposal.run_id, task_id: null, actor, payload: { project_id: projectId, proposal_id: proposalId, decision: "accepted", principle_id: id } },
    ]);
    const added = this.deps.store.principles(projectId).find((p) => p.id === id)!;
    return { id, text: added.text, source: "user", added_at: added.added_at, run_id: added.run_id };
  }

  dismiss(projectId: string, proposalId: string, actor: Actor): void {
    this.allow(actor, projectId);
    const proposal = this.pending(projectId, proposalId);
    this.deps.store.append([{ type: "principle.proposal.decided", run_id: proposal.run_id, task_id: null, actor, payload: { project_id: projectId, proposal_id: proposalId, decision: "dismissed", principle_id: null } }]);
  }

  private pending(projectId: string, proposalId: string) {
    const proposal = this.deps.store.principleProposals(projectId, "pending").find((p) => p.id === proposalId);
    if (!proposal) throw new PrinciplesError("not_found", `no pending proposal ${proposalId}`);
    return proposal;
  }

  private allow(actor: Actor, projectId: string): void {
    const decision = this.deps.policy.decide(actor, "principles.set", `project:${projectId}`, { autonomyLevel: this.deps.autonomyLevel });
    if (decision.effect !== "allow") throw new PrinciplesError("forbidden", decision.reason);
  }

  private compose(projectId: string, file: string[]): PrinciplesView {
    const own: PrincipleView[] = this.deps.store.principles(projectId).map((p) => ({ id: p.id, text: p.text, source: "user", added_at: p.added_at, run_id: p.run_id }));
    const fromFile: PrincipleView[] = file.map((text, i) => ({ id: `file:${i + 1}`, text, source: "file", added_at: null, run_id: null }));
    const seen = new Set(own.map((p) => p.text.toLowerCase()));
    const all = [...own, ...fromFile.filter((p) => !seen.has(p.text.toLowerCase()))];
    const proposals = this.deps.store.principleProposals(projectId, "pending").map((p) => ({ id: p.id, text: p.text, reason: p.reason, run_id: p.run_id, proposed_at: p.proposed_at }));
    return { project_id: projectId, principles: all.slice(0, MAX_PRINCIPLES), proposals, truncated: all.length > MAX_PRINCIPLES };
  }
}

async function fileRules(repoPath: string, commit: string): Promise<string[]> {
  try {
    const text = await readFileAtCommit(repoPath, commit, PRINCIPLES_FILE);
    return text === undefined ? [] : parsePrinciplesFile(text);
  } catch {
    return [];
  }
}
