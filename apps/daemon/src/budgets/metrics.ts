import type { Billing, ModelMetricsView } from "@navarch/contracts";
import type { AttemptRecord } from "../events/store.ts";

/** The Model Router's view of an entry (`Observed` in `@navarch/model-router`), handed over by the Agent Runtime. */
export type Observed = { expectedCost?: number; recent?: { failed: number; total: number } };

/**
 * Observed metrics of spec §6.4.1 (ADR 0023), computed on read from finished agent attempts:
 * per catalog entry, overall or per profile. They feed the Usage screen and the Model Router.
 */

/** Below this many succeeded tasks there is no expected cost. */
export const MIN_COST_SAMPLES = 3;
const DAY_MS = 86_400_000;
/** Ends that say nothing about the model: waiting for a quota, or stopped by the user. */
const NEUTRAL_ERRORS = new Set(["rate_limited", "cancelled"]);

/** The catalog id the attempt was routed to, else its adapter and model. */
export function attemptKey(a: Pick<AttemptRecord, "model_id" | "adapter" | "model">): string {
  return a.model_id ?? (a.model ? `${a.adapter}/${a.model}` : a.adapter);
}

export function modelMetrics(
  attempts: readonly AttemptRecord[],
  opts: { now: number; profile?: string; billingOf: (adapter: string) => Billing },
): ModelMetricsView[] {
  const groups = new Map<string, AttemptRecord[]>();
  for (const a of attempts) {
    if (opts.profile && a.profile !== opts.profile) continue;
    const key = attemptKey(a);
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  return [...groups.entries()]
    .map(([id, rows]) => metricsOf(id, rows, opts.now, opts.profile ?? null, opts.billingOf))
    .sort((a, b) => b.tasks - a.tasks || a.id.localeCompare(b.id));
}

/** What the router needs of each entry for one profile: expected cost and recent failures. */
export function observedFor(attempts: readonly AttemptRecord[], now: number): (id: string, profile: string) => Observed | undefined {
  return (id, profile) => {
    const rows = attempts.filter((a) => attemptKey(a) === id);
    if (!rows.length) return undefined;
    const costs = rows.filter((a) => a.profile === profile && a.status === "succeeded").map((a) => a.cost);
    const recent = recentFailures(rows, now);
    return {
      ...(costs.length >= MIN_COST_SAMPLES ? { expectedCost: median(costs)! } : {}),
      ...(recent.total ? { recent } : {}),
    };
  };
}

function metricsOf(id: string, rows: AttemptRecord[], now: number, profile: string | null, billingOf: (adapter: string) => Billing): ModelMetricsView {
  const first = rows[0]!;
  const ok = rows.filter((a) => a.status === "succeeded");
  const finished = rows.filter((a) => !NEUTRAL_ERRORS.has(a.error_kind ?? ""));
  const recent = recentFailures(rows, now);
  const sum = (pick: (a: AttemptRecord) => number) => rows.reduce((n, a) => n + pick(a), 0);
  return {
    id,
    adapter: first.adapter,
    model: first.model,
    // A record says how it was paid for; an entry whose records were all billed is metered.
    billing: rows.some((a) => a.cost > 0) ? "metered" : rows.some((a) => a.plan_cost > 0) ? "plan" : billingOf(first.adapter),
    profile,
    tasks: rows.length,
    succeeded: ok.length,
    success_rate: finished.length ? round(ok.length / finished.length, 3) : null,
    error_rate_24h: recent.total >= 4 ? round(recent.failed / recent.total, 3) : null,
    rate_limited: rows.filter((a) => a.error_kind === "rate_limited").length,
    tokens_in: sum((a) => a.tokens_in),
    tokens_out: sum((a) => a.tokens_out),
    cached_tokens: sum((a) => a.cached_tokens),
    median_tokens_per_success: median(ok.map((a) => a.tokens_in + a.tokens_out)),
    cost: round(sum((a) => a.cost), 4),
    plan_cost: round(sum((a) => a.plan_cost), 4),
    median_cost_per_success: roundOrNull(median(ok.map((a) => a.cost + a.plan_cost)), 4),
    p50_duration_ms: roundOrNull(median(rows.map((a) => a.duration_ms)), 0),
  };
}

function recentFailures(rows: readonly AttemptRecord[], now: number): { failed: number; total: number } {
  const recent = rows.filter((a) => Date.parse(a.ts) >= now - DAY_MS && !NEUTRAL_ERRORS.has(a.error_kind ?? ""));
  return { failed: recent.filter((a) => a.status === "failed").length, total: recent.length };
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function roundOrNull(n: number | null, digits: number): number | null {
  return n === null ? null : round(n, digits);
}
