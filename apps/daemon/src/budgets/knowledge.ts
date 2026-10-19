import { IMPLEMENTING_PROFILES, type ContextGroup, type KnowledgePanel } from "@navarch/contracts";
import type { AttemptRecord, PullRequestRecord } from "../events/store.ts";
import { median } from "./metrics.ts";

/**
 * The Knowledge panel (ADR 0044): the Phase 3 go/no-go's token goal, read from finished attempts
 * that did or did not carry a compiled context block, and from the PRs of runs on each side.
 */
export const TARGET_REDUCTION = 0.3;
export const MIN_ATTEMPTS = 3;

/** Ends that say nothing about the model, as in the observed metrics. */
const NEUTRAL_ERRORS = new Set(["rate_limited", "cancelled"]);
/** Profiles the context is given to (`CONTEXT_PROFILES` in the Scheduler): the others cannot be compared. */
const COMPARABLE = new Set(["triager", "planner", ...IMPLEMENTING_PROFILES, "researcher", "lead"]);

const input = (a: AttemptRecord) => a.tokens_in + a.cached_tokens;

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function group(rows: readonly AttemptRecord[]): ContextGroup {
  const finished = rows.filter((a) => !NEUTRAL_ERRORS.has(a.error_kind ?? ""));
  const succeeded = rows.filter((a) => a.status === "succeeded");
  const med = median(rows.filter((a) => input(a) > 0).map(input));
  return {
    attempts: rows.length,
    succeeded: succeeded.length,
    success_rate: finished.length ? round(succeeded.length / finished.length, 3) : null,
    median_input_tokens: med === null ? null : Math.round(med),
  };
}

function reduction(w: ContextGroup, wo: ContextGroup): number | null {
  if (w.attempts < MIN_ATTEMPTS || wo.attempts < MIN_ATTEMPTS || !w.median_input_tokens || !wo.median_input_tokens) return null;
  return round(1 - w.median_input_tokens / wo.median_input_tokens, 3);
}

export function knowledgePanel(attempts: readonly AttemptRecord[], prs: readonly PullRequestRecord[]): KnowledgePanel {
  const rows = attempts.filter((a) => COMPARABLE.has(a.profile));
  const withCtx = rows.filter((a) => a.context_tokens !== null);
  const without = rows.filter((a) => a.context_tokens === null);

  const profiles = [...new Set(rows.map((a) => a.profile))]
    .sort()
    .map((profile) => {
      const w = group(withCtx.filter((a) => a.profile === profile));
      const wo = group(without.filter((a) => a.profile === profile));
      return { profile, with: w, without: wo, reduction: reduction(w, wo) };
    });
  const w = group(withCtx);
  const wo = group(without);
  const overall = { with: w, without: wo, reduction: reduction(w, wo) };

  // A run is on a side only when all its comparable attempts are: mixed runs say nothing.
  const sideOf = new Map<string, Set<boolean>>();
  for (const a of rows) sideOf.set(a.run_id, (sideOf.get(a.run_id) ?? new Set()).add(a.context_tokens !== null));
  const prGroup = (side: boolean) => {
    const closed = prs.filter((p) => (p.state === "merged" || p.state === "closed") && sideOf.get(p.run_id)?.size === 1 && sideOf.get(p.run_id)!.has(side));
    const merged = closed.filter((p) => p.state === "merged").length;
    return { closed: closed.length, merged, acceptance_rate: closed.length ? round(merged / closed.length, 3) : null };
  };
  const prWith = prGroup(true);
  const prWithout = prGroup(false);

  const held = (a: number | null, b: number | null) => a === null || b === null || a >= b;
  let verdict: KnowledgePanel["verdict"] = "insufficient";
  if (overall.reduction !== null) {
    const ok =
      overall.reduction >= TARGET_REDUCTION && held(w.success_rate, wo.success_rate) && held(prWith.acceptance_rate, prWithout.acceptance_rate);
    verdict = ok ? "met" : "not_met";
  }

  return {
    target_reduction: TARGET_REDUCTION,
    min_attempts: MIN_ATTEMPTS,
    context: {
      attempts: withCtx.length,
      median_est_tokens: (() => {
        const m = median(withCtx.map((a) => a.context_tokens!));
        return m === null ? null : Math.round(m);
      })(),
    },
    profiles,
    overall,
    pull_requests: { with: prWith, without: prWithout },
    verdict,
  };
}
