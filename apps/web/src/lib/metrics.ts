import type { CostPanel, PullRequestState } from "@navarch/contracts";

/** Cost and quality panels (ADR 0037): what the Usage screen's Cost and Quality tabs draw. */

export const USAGE_TABS = ["overview", "cost", "quality"] as const;
export type UsageTab = (typeof USAGE_TABS)[number];
export const METRIC_WINDOWS = [7, 30, 90] as const;

/** §17 targets the Quality tab compares with: at least half of the PRs merged, under a quarter reworked. */
export const TARGETS = { acceptance: 0.5, rework: 0.25 } as const;

/** The smallest "round" number (1, 2 or 5 × 10ⁿ) at or above `n`, for the chart's top gridline. */
export function niceCeil(n: number): number {
  if (!(n > 0)) return 1;
  const step = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 5, 10]) if (m * step >= n - 1e-12) return m * step;
  return 10 * step;
}

export type DayBar = { day: string; cost: number; plan_cost: number; tokens: number; billedPct: number; planPct: number };

/** Each day's billed and plan-equivalent cost as heights in percent of the axis top. */
export function dayBars(days: CostPanel["days"]): { top: number; bars: DayBar[] } {
  const top = niceCeil(Math.max(0, ...days.map((d) => d.cost + d.plan_cost)));
  return { top, bars: days.map((d) => ({ ...d, billedPct: (d.cost / top) * 100, planPct: (d.plan_cost / top) * 100 })) };
}

/** A row's billed and plan-equivalent cost as widths in percent of the largest row. */
export function shareBars<T extends { cost: number; plan_cost: number }>(rows: readonly T[]): (T & { billedPct: number; planPct: number })[] {
  const max = Math.max(0, ...rows.map((r) => r.cost + r.plan_cost));
  return rows.map((r) => ({ ...r, billedPct: max ? (r.cost / max) * 100 : 0, planPct: max ? (r.plan_cost / max) * 100 : 0 }));
}

export const prTone: Record<PullRequestState, "info" | "success" | "danger" | "muted"> = { open: "info", merged: "success", closed: "danger", gone: "muted" };

/** Whether a rate meets its §17 target; null without a rate. */
export function meetsTarget(kind: keyof typeof TARGETS, rate: number | null): boolean | null {
  if (rate === null) return null;
  return kind === "acceptance" ? rate >= TARGETS.acceptance : rate < TARGETS.rework;
}

export function loadTab(): UsageTab {
  try {
    const saved = localStorage.getItem("navarch.usage.tab");
    return (USAGE_TABS as readonly string[]).includes(saved ?? "") ? (saved as UsageTab) : "overview";
  } catch {
    return "overview";
  }
}

export function saveTab(tab: UsageTab): void {
  try {
    localStorage.setItem("navarch.usage.tab", tab);
  } catch {
    // Private windows may refuse storage; the tab is then not remembered.
  }
}
