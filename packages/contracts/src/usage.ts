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

/** Spend of one slice of the Cost Ledger: billed apart from plan-equivalent (ADR 0023). */
const Spend = Totals;

/** The cost panel of spec §6.15 (ADR 0037): the window's spend by day, project, profile and model. */
export const CostPanel = z.object({
  total: Spend,
  /** Every local day of the window, oldest first, `YYYY-MM-DD`; days without use are zero. */
  days: z.array(Spend.extend({ day: z.string() })),
  /** Registered projects, then other repository paths, then use outside runs (`kind: "outside"`). */
  projects: z.array(
    Spend.extend({
      kind: z.enum(["project", "repo", "outside"]),
      project_id: z.string().nullable(),
      label: z.string(),
      runs: z.number().int().nonnegative(),
    }),
  ),
  /** Per agent profile of the task; null for use outside runs (Inbox triage). */
  profiles: z.array(Spend.extend({ profile: z.string().nullable(), tasks: z.number().int().nonnegative() })),
  models: z.array(Spend.extend({ model: z.string(), calls: z.number().int().nonnegative() })),
});
export type CostPanel = z.infer<typeof CostPanel>;

export const PullRequestState = z.enum(["open", "merged", "closed", "gone"]);
export type PullRequestState = z.infer<typeof PullRequestState>;

/** A pull request Navarch opened and what became of it (ADR 0037). */
export const PullRequestOutcomeView = z.object({
  run_id: z.string(),
  run_name: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  state: PullRequestState,
  opened_at: z.string(),
  closed_at: z.string().nullable(),
  /** Commits on the head after Navarch's last push; null while open or when GitHub could not compare. */
  commits_after: z.number().int().nonnegative().nullable(),
  cost: z.number().nonnegative(),
  plan_cost: z.number().nonnegative(),
});
export type PullRequestOutcomeView = z.infer<typeof PullRequestOutcomeView>;

const Rate = z.number().min(0).max(1).nullable();

/** The quality panel of spec §6.15 (ADR 0037). */
export const QualityPanel = z.object({
  profiles: z.array(
    z.object({
      profile: z.string(),
      tasks: z.number().int().nonnegative(),
      succeeded: z.number().int().nonnegative(),
      /** Over finished tasks, rate limits and cancellations left out. */
      success_rate: Rate,
      rate_limited: z.number().int().nonnegative(),
    }),
  ),
  models: z.array(ModelMetricsView),
  /** Pull requests opened in the window. */
  pull_requests: z.object({
    opened: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    merged: z.number().int().nonnegative(),
    closed: z.number().int().nonnegative(),
    gone: z.number().int().nonnegative(),
    /** Merged over merged + closed; null before one closes. */
    acceptance_rate: Rate,
    /** Merged with no commit after Navarch's. */
    accepted_as_is: z.number().int().nonnegative(),
    /** Closed with more than two commits after Navarch's (§17). */
    rework: z.number().int().nonnegative(),
    rework_rate: Rate,
    /** Billed + plan-equivalent cost of the merged PRs' runs per merged PR. */
    cost_per_merged: z.number().nonnegative().nullable(),
    recent: z.array(PullRequestOutcomeView),
  }),
});
export type QualityPanel = z.infer<typeof QualityPanel>;

/** One side of the context comparison: attempts with or without a compiled context block (ADR 0044). */
export const ContextGroup = z.object({
  attempts: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  success_rate: Rate,
  /** Median input per attempt: fresh plus cached input tokens. */
  median_input_tokens: z.number().nullable(),
});
export type ContextGroup = z.infer<typeof ContextGroup>;

const ContextPrGroup = z.object({
  closed: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  acceptance_rate: Rate,
});

/**
 * Phase 3's token goal (spec §16): the input tokens per Task with the compiled context against
 * without it, per profile and overall, and whether PR acceptance held (ADR 0044).
 */
export const KnowledgePanel = z.object({
  /** The reduction to reach, from the go/no-go (0.3). */
  target_reduction: z.number(),
  /** Attempts needed on each side before a reduction is reported. */
  min_attempts: z.number().int().positive(),
  /** Attempts that carried a block, and the block's own median size. */
  context: z.object({ attempts: z.number().int().nonnegative(), median_est_tokens: z.number().nullable() }),
  profiles: z.array(z.object({ profile: z.string(), with: ContextGroup, without: ContextGroup, reduction: z.number().nullable() })),
  overall: z.object({ with: ContextGroup, without: ContextGroup, reduction: z.number().nullable() }),
  /** Runs where every comparable attempt had a block (with) or none (without); mixed runs count in neither. */
  pull_requests: z.object({ with: ContextPrGroup, without: ContextPrGroup }),
  /** `insufficient` until both sides have `min_attempts`; `met` needs the target and no drop in success or acceptance. */
  verdict: z.enum(["met", "not_met", "insufficient"]),
});
export type KnowledgePanel = z.infer<typeof KnowledgePanel>;

export const MetricsView = z.object({
  generated_at: z.string(),
  window_days: z.number().int().positive(),
  cost: CostPanel,
  quality: QualityPanel,
  knowledge: KnowledgePanel,
});
export type MetricsView = z.infer<typeof MetricsView>;
