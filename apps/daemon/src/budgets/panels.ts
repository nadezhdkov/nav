import type { CostPanel, ModelMetricsView, QualityPanel } from "@navarch/contracts";
import type { AttemptRecord, LedgerRow, ProjectRecord, PullRequestRecord } from "../events/store.ts";
import { localDate } from "./budgets.ts";

/**
 * The cost and quality panels of spec §6.15 (ADR 0037), computed on read from the Cost Ledger,
 * finished agent attempts and the pull requests Navarch opened, like the observed metrics.
 */

/** Ends that say nothing about the model, as in the observed metrics. */
const NEUTRAL_ERRORS = new Set(["rate_limited", "cancelled"]);
/** More commits than this after Navarch's last push count as rework (§17: "> 2 rounds of adjustment"). */
export const REWORK_COMMITS = 2;
const RECENT_PRS = 20;

type Spend = { cost: number; plan_cost: number; tokens: number };

/** The first instant of the window: local midnight `days - 1` days before `now`. */
export function windowStart(now: number, days: number): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d;
}

export function costPanel(rows: readonly LedgerRow[], opts: { now: number; days: number; projects: readonly ProjectRecord[] }): CostPanel {
  const add = (s: Spend, r: LedgerRow) => {
    if (r.billing === "plan") s.plan_cost += r.cost;
    else s.cost += r.cost;
    s.tokens += r.tokens;
  };
  const zero = (): Spend => ({ cost: 0, plan_cost: 0, tokens: 0 });

  const total = zero();
  const days = new Map<string, Spend>();
  for (let d = windowStart(opts.now, opts.days), i = 0; i < opts.days; i++, d.setDate(d.getDate() + 1)) days.set(localDate(d), zero());

  const byPath = new Map(opts.projects.map((p) => [p.path, p]));
  const places = new Map<string, Spend & { kind: "project" | "repo" | "outside"; project_id: string | null; label: string; runs: Set<string> }>();
  const profiles = new Map<string | null, Spend & { tasks: Set<string> }>();
  const models = new Map<string, Spend & { calls: number }>();

  for (const r of rows) {
    add(total, r);
    const day = days.get(localDate(new Date(r.ts)));
    if (day) add(day, r);

    const project = r.repo_path ? byPath.get(r.repo_path) : undefined;
    const key = project ? `p:${project.id}` : r.repo_path ? `r:${r.repo_path}` : "outside";
    let place = places.get(key);
    if (!place) {
      place = {
        ...zero(),
        kind: project ? "project" : r.repo_path ? "repo" : "outside",
        project_id: project?.id ?? null,
        label: project?.name ?? r.repo_path ?? "outside runs",
        runs: new Set(),
      };
      places.set(key, place);
    }
    add(place, r);
    if (r.run_id) place.runs.add(r.run_id);

    const profile = r.run_id ? (r.profile ?? "other") : null;
    let p = profiles.get(profile);
    if (!p) profiles.set(profile, (p = { ...zero(), tasks: new Set() }));
    add(p, r);
    if (r.task_id) p.tasks.add(r.task_id);

    let m = models.get(r.model);
    if (!m) models.set(r.model, (m = { ...zero(), calls: 0 }));
    add(m, r);
    m.calls++;
  }

  const kindOrder = { project: 0, repo: 1, outside: 2 };
  const bySpend = (a: Spend, b: Spend) => b.cost + b.plan_cost - (a.cost + a.plan_cost) || b.tokens - a.tokens;
  return {
    total: rounded(total),
    days: [...days.entries()].map(([day, s]) => ({ day, ...rounded(s) })),
    projects: [...places.values()]
      .sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || bySpend(a, b) || a.label.localeCompare(b.label))
      .map(({ runs, ...s }) => ({ ...s, ...rounded(s), runs: runs.size })),
    profiles: [...profiles.entries()]
      .sort(([a, x], [b, y]) => Number(a === null) - Number(b === null) || bySpend(x, y))
      .map(([profile, { tasks, ...s }]) => ({ profile, ...rounded(s), tasks: tasks.size })),
    models: [...models.entries()].sort(([, a], [, b]) => bySpend(a, b)).map(([model, s]) => ({ model, ...rounded(s), calls: s.calls })),
  };
}

export function qualityPanel(attempts: readonly AttemptRecord[], prs: readonly PullRequestRecord[], models: ModelMetricsView[]): QualityPanel {
  const byProfile = new Map<string, AttemptRecord[]>();
  for (const a of attempts) byProfile.set(a.profile, [...(byProfile.get(a.profile) ?? []), a]);
  const profiles = [...byProfile.entries()]
    .map(([profile, rows]) => {
      const succeeded = rows.filter((a) => a.status === "succeeded").length;
      const finished = rows.filter((a) => !NEUTRAL_ERRORS.has(a.error_kind ?? "")).length;
      return {
        profile,
        tasks: rows.length,
        succeeded,
        success_rate: finished ? round(succeeded / finished, 3) : null,
        rate_limited: rows.filter((a) => a.error_kind === "rate_limited").length,
      };
    })
    .sort((a, b) => b.tasks - a.tasks || a.profile.localeCompare(b.profile));

  const count = (state: PullRequestRecord["state"]) => prs.filter((p) => p.state === state).length;
  const merged = prs.filter((p) => p.state === "merged");
  const closed = prs.filter((p) => p.state === "merged" || p.state === "closed");
  const judged = closed.filter((p) => p.commits_after !== null);
  const rework = judged.filter((p) => p.commits_after! > REWORK_COMMITS).length;
  return {
    profiles,
    models,
    pull_requests: {
      opened: prs.length,
      open: count("open"),
      merged: merged.length,
      closed: count("closed"),
      gone: count("gone"),
      acceptance_rate: closed.length ? round(merged.length / closed.length, 3) : null,
      accepted_as_is: merged.filter((p) => p.commits_after === 0).length,
      rework,
      rework_rate: judged.length ? round(rework / judged.length, 3) : null,
      cost_per_merged: merged.length ? round(merged.reduce((n, p) => n + p.cost + p.plan_cost, 0) / merged.length, 4) : null,
      recent: prs.slice(0, RECENT_PRS).map((p) => ({
        run_id: p.run_id,
        run_name: p.run_name,
        repo: p.repo,
        number: p.number,
        url: p.url,
        state: p.state,
        opened_at: p.opened_at,
        closed_at: p.closed_at,
        commits_after: p.commits_after,
        cost: round(p.cost, 4),
        plan_cost: round(p.plan_cost, 4),
      })),
    },
  };
}

function rounded(s: Spend): Spend {
  return { cost: round(s.cost, 4), plan_cost: round(s.plan_cost, 4), tokens: s.tokens };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
