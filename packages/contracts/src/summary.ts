import { z } from "zod";

/** The morning summary of the nightly triage (spec §7.4, ADR 0059). Titles are untrusted text (T1). */

const SummaryItem = z.object({
  id: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  kind: z.string().nullable(),
  complexity: z.number().int().min(1).max(5).nullable(),
  suggested_action: z.string().nullable(),
  /** The Flow the triage suggests when the action is `start_run`. */
  flow: z.string().nullable(),
  /** Median cost of finished `fix-issue` runs with the same complexity; null below 3 runs. */
  estimate_usd: z.number().nonnegative().nullable(),
});

export const MorningSummary = z.object({
  id: z.string(),
  generated_at: z.string(),
  /** The previous summary's time, or 24 h before this one when there was none. */
  since: z.string(),
  /** Items that arrived or changed since `since`, most promising first, at most 10. */
  new_items: z.array(SummaryItem),
  new_total: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  ci_failures: z.array(z.object({ id: z.string(), repo: z.string(), number: z.number().int().positive(), title: z.string() })),
  /** Draft PRs of Navarch's still open after `summary.stalled_days`. */
  stalled_prs: z.array(z.object({ repo: z.string(), number: z.number().int().positive(), url: z.string(), days: z.number().int().nonnegative() })),
  approvals_waiting: z.number().int().nonnegative(),
  runs_finished: z.number().int().nonnegative(),
  runs_failed: z.number().int().nonnegative(),
  /** Billed cost of the runs that finished since `since`. */
  billed_usd: z.number().nonnegative(),
  /** Items worth a run (`start_run` and complexity ≤ 3) with the estimate of starting all of them. */
  suggestions: z.array(SummaryItem),
  suggestions_estimate_usd: z.number().nonnegative(),
});
export type MorningSummary = z.infer<typeof MorningSummary>;
