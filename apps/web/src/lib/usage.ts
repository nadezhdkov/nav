import type { BudgetView, ModelMetricsView } from "@navarch/contracts";

/** Columns of the models table that sort; text columns sort by name, the others by value. */
export const SORT_KEYS = ["id", "tasks", "success_rate", "error_rate_24h", "tokens", "median_tokens_per_success", "median_cost_per_success", "cost", "plan_cost", "p50_duration_ms"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

function value(m: ModelMetricsView, key: SortKey): number | string | null {
  return key === "tokens" ? m.tokens_in + m.tokens_out : m[key];
}

/** Sorted copy; missing values (too little history) always go last. */
export function sortModels(models: readonly ModelMetricsView[], key: SortKey, dir: "asc" | "desc"): ModelMetricsView[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...models].sort((a, b) => {
    const va = value(a, key);
    const vb = value(b, key);
    if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1;
    const order = typeof va === "string" ? va.localeCompare(String(vb)) : va - (vb as number);
    return order * sign || a.id.localeCompare(b.id);
  });
}

/** Width of a budget bar in percent, capped at 100; a scope without a limit has no bar. */
export function budgetPercent(b: BudgetView): number | null {
  return b.ratio === null ? null : Math.min(100, Math.round(b.ratio * 100));
}

export const budgetTone = { ok: "success", warning: "warning", exceeded: "danger" } as const;

/** Budgets worth showing: the global month and projects always, runs only near or over their limit. */
export function visibleBudgets(budgets: readonly BudgetView[]): BudgetView[] {
  return budgets.filter((b) => b.scope !== "run" || b.state !== "ok");
}

export function compactTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
