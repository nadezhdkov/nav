import { z } from "zod";
import { Billing, BudgetScope } from "./events.ts";
import { QuotaView } from "./inbox.ts";

/** One budget scope's state for its current period (ADR 0023). Only billed cost counts. */
export const BudgetView = z.object({
  scope: BudgetScope,
  /** Run or project id; null for the global month. */
  target: z.string().nullable(),
  /** The run's title, the project's name or "global". */
  label: z.string(),
  /** The run id, local day `YYYY-MM-DD` or local month `YYYY-MM`. */
  period: z.string(),
  /** Null when the scope has no limit. */
  limit: z.number().positive().nullable(),
  /** Where the limit comes from: the config, a `budget.set`, or the run's own budget. */
  source: z.enum(["config", "override", "run"]),
  used: z.number().nonnegative(),
  plan_equivalent: z.number().nonnegative(),
  ratio: z.number().nonnegative().nullable(),
  state: z.enum(["ok", "warning", "exceeded"]),
});
export type BudgetView = z.infer<typeof BudgetView>;

export const SetBudgetRequest = z
  .object({
    scope: BudgetScope,
    target: z.string().min(1).optional(),
    /** Null removes a project or global limit; a run always keeps one. */
    usd: z.number().positive().max(100_000).nullable(),
  })
  .refine((b) => (b.scope === "global_monthly") === (b.target === undefined), { message: "target is required for run and project budgets, and not allowed for the global one" })
  .refine((b) => b.scope !== "run" || b.usd !== null, { message: "a run budget cannot be removed" });
export type SetBudgetRequest = z.infer<typeof SetBudgetRequest>;

/** Observed metrics of one catalog entry (adapter + model), overall or for one profile (spec §6.4.1). */
export const ModelMetricsView = z.object({
  /** Catalog id when the tasks were routed, else `<adapter>` or `<adapter>/<model>`. */
  id: z.string(),
  adapter: z.string(),
  model: z.string().nullable(),
  billing: Billing,
  profile: z.string().nullable(),
  tasks: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  success_rate: z.number().min(0).max(1).nullable(),
  /** Failures other than rate limits and cancellations over finished tasks of the last 24 h; null below 4 tasks. */
  error_rate_24h: z.number().min(0).max(1).nullable(),
  /**
   * Tasks that ended on a rate limit or exhausted quota. They are left out of both rates, which
   * judge the model, but show how often the agent was not available.
   */
  rate_limited: z.number().int().nonnegative(),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative(),
  /** Median tokens (in + out) of succeeded tasks; null without one. */
  median_tokens_per_success: z.number().nonnegative().nullable(),
  cost: z.number().nonnegative(),
  plan_cost: z.number().nonnegative(),
  /** Median billed + plan-equivalent cost of succeeded tasks; null without one. */
  median_cost_per_success: z.number().nonnegative().nullable(),
  p50_duration_ms: z.number().int().nonnegative().nullable(),
});
export type ModelMetricsView = z.infer<typeof ModelMetricsView>;

const Totals = z.object({
  cost: z.number().nonnegative(),
  plan_cost: z.number().nonnegative(),
  tokens: z.number().int().nonnegative(),
});

export const UsageView = z.object({
  generated_at: z.string(),
  window_days: z.number().int().positive(),
  today: Totals,
  month: Totals,
  budgets: z.array(BudgetView),
  models: z.array(ModelMetricsView),
  quotas: z.array(QuotaView),
});
export type UsageView = z.infer<typeof UsageView>;
