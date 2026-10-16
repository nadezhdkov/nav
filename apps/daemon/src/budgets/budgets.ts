import type { Actor, BudgetView, NavarchEvent, NewEvent, RunView, SetBudgetRequest } from "@navarch/contracts";
import type { Config } from "../config.ts";
import type { EventStore, ProjectRecord } from "../events/store.ts";

/**
 * The Cost Ledger's budgets (spec §6.1.4, ADR 0023): per run, per registered project and local
 * day, and globally per local month. Only billed (`metered`) use counts; plan use is bounded by
 * quotas. Limits come from the config, overridden by `budget.set` events from the user.
 */
export class Budgets {
  private readonly deps: { store: EventStore; config: Config };
  private readonly now: () => number;
  /**
   * What each running billed agent may still spend, by the limited scopes it counts towards
   * (ADR 0030). In memory like the running tasks themselves: a restart requeues them.
   */
  private readonly held = new Map<string, { scopes: string[]; cap: number }>();

  constructor(deps: { store: EventStore; config: Config; now?: () => number }) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Every scope a run counts towards: the run itself, its project's day (if registered) and the global month. */
  scopesOf(run: Pick<RunView, "id" | "repo_path" | "budget" | "prompt">): BudgetView[] {
    const used = this.deps.store.usageTotals(null, { runId: run.id });
    const views = [view("run", run.id, title(run.prompt), run.id, run.budget, "run", used, this.threshold)];
    const project = this.projectOf(run.repo_path);
    if (project) views.push(this.projectView(project));
    views.push(this.globalView());
    return views;
  }

  /** The global month, every registered project's day, and the active runs: the Usage screen. */
  views(): BudgetView[] {
    const runs = this.deps.store
      .listRuns(200)
      .filter((r) => !["done", "failed", "cancelled"].includes(r.status))
      .map((r) => view("run", r.id, title(r.prompt), r.id, r.budget, "run", this.deps.store.usageTotals(null, { runId: r.id }), this.threshold));
    return [this.globalView(), ...this.deps.store.listProjects().map((p) => this.projectView(p)), ...runs];
  }

  /** The smallest amount left across a run's limited scopes; Infinity when none is limited. */
  remaining(run: Pick<RunView, "id" | "repo_path" | "budget" | "prompt">): number {
    return Math.max(
      0,
      Math.min(...this.scopesOf(run).map((s) => (s.limit === null ? Infinity : s.limit - s.used))),
    );
  }

  /**
   * What a new billed agent of this run may spend (ADR 0030): the smallest amount left across the
   * run's limited scopes, less what the running billed agents of each scope hold and have not spent
   * yet. Infinity when no scope is limited.
   */
  available(run: Pick<RunView, "id" | "repo_path" | "budget" | "prompt">, except?: string): number {
    const limited = this.scopesOf(run).filter((s) => s.limit !== null);
    if (!limited.length) return Infinity;
    const outstanding = new Map<string, number>();
    for (const [taskId, h] of this.held) {
      if (taskId === except) continue;
      const left = Math.max(0, h.cap - this.deps.store.taskSpend(taskId));
      for (const key of h.scopes) outstanding.set(key, (outstanding.get(key) ?? 0) + left);
    }
    return Math.max(0, Math.min(...limited.map((s) => s.limit! - s.used - (outstanding.get(scopeKey(s)) ?? 0))));
  }

  /** Whether running billed agents hold part of a scope this run counts towards. */
  heldFor(run: Pick<RunView, "id" | "repo_path" | "budget" | "prompt">): boolean {
    const keys = new Set(this.scopesOf(run).filter((s) => s.limit !== null).map(scopeKey));
    return [...this.held.values()].some((h) => h.scopes.some((k) => keys.has(k)));
  }

  /** The limited scopes a run counts towards, as keys: two runs compete for a budget when they share one. */
  limitedScopes(run: Pick<RunView, "id" | "repo_path" | "budget" | "prompt">): string[] {
    return this.scopesOf(run).filter((s) => s.limit !== null).map(scopeKey);
  }

  /** A billed agent starts with this cap: it is held from the run's scopes until `release`. */
  reserve(run: Pick<RunView, "id" | "repo_path" | "budget" | "prompt">, taskId: string, cap: number): void {
    if (!Number.isFinite(cap)) return;
    this.held.set(taskId, { scopes: this.limitedScopes(run), cap });
  }

  release(taskId: string): void {
    this.held.delete(taskId);
  }

  /** `budget.threshold` events for scopes of the run (or only the global month) that crossed a threshold not recorded yet. */
  thresholdEvents(run: Pick<RunView, "id" | "repo_path" | "budget" | "prompt"> | undefined): NewEvent<"budget.threshold">[] {
    const scopes = run ? this.scopesOf(run) : [this.globalView()];
    const events: NewEvent<"budget.threshold">[] = [];
    for (const s of scopes) {
      if (s.limit === null || s.ratio === null) continue;
      for (const ratio of [this.threshold, 1]) {
        if (s.ratio < ratio || this.deps.store.budgetAlerted(s.scope, s.target, s.period, ratio)) continue;
        events.push({
          type: "budget.threshold",
          run_id: s.scope === "run" ? s.target : (run?.id ?? null),
          task_id: null,
          actor: { kind: "system", component: "budgets" },
          payload: { scope: s.scope, target: s.target, period: s.period, ratio, used: round(s.used), limit: s.limit },
        });
      }
    }
    return events;
  }

  /** The event that applies the user's change; throws on an unknown run or project. */
  setEvent(req: SetBudgetRequest, actor: Actor): NewEvent<"budget.set"> {
    let previous: number | null;
    if (req.scope === "run") {
      const run = this.deps.store.getRun(req.target!);
      if (!run) throw new BudgetError("not_found", `unknown run ${req.target}`);
      previous = run.budget;
    } else if (req.scope === "project_daily") {
      const project = this.deps.store.getProject(req.target!);
      if (!project || project.removed_at) throw new BudgetError("not_found", `unknown project ${req.target}`);
      previous = this.projectView(project).limit;
    } else {
      previous = this.globalView().limit;
    }
    return {
      type: "budget.set",
      run_id: req.scope === "run" ? req.target! : null,
      task_id: null,
      actor,
      payload: { scope: req.scope, target: req.target ?? null, usd: req.usd, previous },
    };
  }

  private get threshold(): number {
    return this.deps.config.budgets.alert_threshold;
  }

  private projectOf(repoPath: string): ProjectRecord | undefined {
    return this.deps.store.listProjects().find((p) => p.path === repoPath);
  }

  private projectView(project: ProjectRecord): BudgetView {
    const override = this.deps.store.budgetOverride("project_daily", project.id);
    const limit = override ? override.usd : this.deps.config.budgets.project_daily;
    const { from, period } = this.day();
    const used = this.deps.store.usageTotals(from, { repoPath: project.path });
    return view("project_daily", project.id, project.name, period, limit, override ? "override" : "config", used, this.threshold);
  }

  private globalView(): BudgetView {
    const override = this.deps.store.budgetOverride("global_monthly", null);
    const limit = override ? override.usd : this.deps.config.budgets.global_monthly;
    const { from, period } = this.month();
    return view("global_monthly", null, "global", period, limit, override ? "override" : "config", this.deps.store.usageTotals(from), this.threshold);
  }

  /** The PC's local day: its start as ISO 8601 and its `YYYY-MM-DD` label. */
  day(): { from: string; period: string } {
    const d = new Date(this.now());
    d.setHours(0, 0, 0, 0);
    return { from: d.toISOString(), period: localDate(d).slice(0, 10) };
  }

  /** The PC's local calendar month: its start and its `YYYY-MM` label. */
  month(): { from: string; period: string } {
    const d = new Date(this.now());
    d.setHours(0, 0, 0, 0);
    d.setDate(1);
    return { from: d.toISOString(), period: localDate(d).slice(0, 7) };
  }
}

export class BudgetError extends Error {
  readonly code: "not_found";

  constructor(code: "not_found", message: string) {
    super(message);
    this.code = code;
  }
}

/** Whether an event can move a budget: billed use was recorded. */
export function spends(event: NavarchEvent): boolean {
  return (event.type === "model.call.completed" && (event as NavarchEvent<"model.call.completed">).payload.billing !== "plan") || event.type === "workitem.triaged";
}

const scopeKey = (s: Pick<BudgetView, "scope" | "target" | "period">) => `${s.scope}:${s.target ?? ""}:${s.period}`;

function view(
  scope: BudgetView["scope"],
  target: string | null,
  label: string,
  period: string,
  limit: number | null,
  source: BudgetView["source"],
  used: { cost: number; plan_cost: number },
  threshold: number,
): BudgetView {
  const ratio = limit ? used.cost / limit : null;
  return {
    scope,
    target,
    label,
    period,
    limit,
    source,
    used: round(used.cost),
    plan_equivalent: round(used.plan_cost),
    ratio: ratio === null ? null : Math.round(ratio * 1000) / 1000,
    state: ratio === null ? "ok" : ratio >= 1 ? "exceeded" : ratio >= threshold ? "warning" : "ok",
  };
}

function title(prompt: string): string {
  const line = prompt.split("\n")[0]!.trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
