import { randomUUID } from "node:crypto";
import type { Actor, InboxItemView, MorningSummary } from "@navarch/contracts";
import type { Config } from "../config.ts";
import type { EventStore } from "../events/store.ts";

const daemon: Actor = { kind: "system", component: "summary" };
const TICK_MS = 60_000;
const DAY_MS = 24 * 3600_000;
const LISTED = 10;
/** Suggestions are items worth a run: the triage said so and the work is small enough to leave alone. */
const MAX_SUGGESTED_COMPLEXITY = 3;

export interface SummaryDeps {
  config: Config;
  store: EventStore;
  /** Syncs the projects, the open PRs and the CI failures before the summary reads them. */
  refresh: () => Promise<void>;
  /** The Inbox's open items with their triage and estimate. */
  items: () => InboxItemView[];
  now?: () => Date;
}

/**
 * The morning summary (spec §7.4, ADR 0059): once a day, after a sync, it reads what the Inbox, the
 * PR and CI watchers and the runs already know and records it as `summary.generated`. No model call
 * and no side effect besides the event; the Notifier turns that event into a push.
 */
export class SummaryService {
  private readonly deps: SummaryDeps;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<MorningSummary> | undefined;

  constructor(deps: SummaryDeps) {
    this.deps = deps;
  }

  start(): void {
    if (!this.deps.config.summary.enabled) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), TICK_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => {});
  }

  latest(): MorningSummary | undefined {
    return this.deps.store.latestSummary();
  }

  /** Makes the day's summary when it is time and none was made today (local time). */
  async tick(): Promise<MorningSummary | undefined> {
    const now = this.deps.now?.() ?? new Date();
    const [h, m] = this.deps.config.summary.at.split(":").map(Number);
    if (now.getHours() * 60 + now.getMinutes() < (h ?? 0) * 60 + (m ?? 0)) return undefined;
    const last = this.latest();
    if (last && localDay(new Date(last.generated_at)) === localDay(now)) return undefined;
    return this.generate();
  }

  /** Syncs, builds and records a summary now (`navarch summary --now`). One at a time. */
  generate(): Promise<MorningSummary> {
    this.running ??= this.make().finally(() => (this.running = undefined));
    return this.running;
  }

  private async make(): Promise<MorningSummary> {
    await this.deps.refresh().catch(() => {});
    const summary = this.build();
    this.deps.store.append([{ type: "summary.generated", run_id: null, task_id: null, actor: daemon, payload: summary }]);
    return summary;
  }

  /** The summary as the store knows things now; pure reads. */
  build(): MorningSummary {
    const { store, config } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    const generated_at = now.toISOString();
    const since = this.latest()?.generated_at ?? new Date(now.getTime() - DAY_MS).toISOString();

    const open = this.deps.items().filter((i) => i.status === "new" || i.status === "triaged");
    const fresh = open.filter((i) => i.updated_at > since);
    const rank = (i: InboxItemView) => (i.triage?.suggested_action === "start_run" ? 0 : i.triage ? 1 : 2);
    const sorted = [...fresh].sort((a, b) => rank(a) - rank(b) || (a.triage?.complexity ?? 9) - (b.triage?.complexity ?? 9));
    const suggested = open
      .filter((i) => i.triage?.suggested_action === "start_run" && i.triage.complexity <= MAX_SUGGESTED_COMPLEXITY)
      .sort((a, b) => (a.triage?.complexity ?? 9) - (b.triage?.complexity ?? 9));

    const stalledBefore = now.getTime() - config.summary.stalled_days * DAY_MS;
    const runs = store.listRuns(500).filter((r) => r.ended_at !== null && r.ended_at >= since);

    return {
      id: `sum_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      generated_at,
      since,
      new_items: sorted.slice(0, LISTED).map(itemOf),
      new_total: fresh.length,
      duplicates: open.filter((i) => i.triage?.suggested_action === "duplicate" || i.triage?.duplicate_of != null).length,
      ci_failures: store
        .ciFailures("open")
        .slice(0, LISTED)
        .map((f) => ({ id: f.id, repo: f.repo, number: f.number, title: f.title })),
      stalled_prs: store
        .openPullRequests()
        .filter((p) => Date.parse(p.opened_at) <= stalledBefore)
        .slice(0, LISTED)
        .map((p) => ({ repo: p.repo, number: p.number, url: p.url, days: Math.floor((now.getTime() - Date.parse(p.opened_at)) / DAY_MS) })),
      approvals_waiting: store.listApprovals("pending").length,
      runs_finished: runs.length,
      runs_failed: runs.filter((r) => r.status === "failed").length,
      billed_usd: round(runs.reduce((sum, r) => sum + r.cost_total, 0)),
      suggestions: suggested.slice(0, LISTED).map(itemOf),
      suggestions_estimate_usd: round(suggested.slice(0, LISTED).reduce((sum, i) => sum + (i.estimate?.usd ?? 0), 0)),
    };
  }
}

function itemOf(i: InboxItemView): MorningSummary["new_items"][number] {
  return {
    id: i.id,
    repo: i.repo,
    number: i.number,
    title: i.title,
    kind: i.triage?.kind ?? null,
    complexity: i.triage?.complexity ?? null,
    suggested_action: i.triage?.suggested_action ?? null,
    flow: i.triage?.flow ?? null,
    estimate_usd: i.estimate?.usd ?? null,
  };
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
