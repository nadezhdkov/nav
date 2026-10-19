# Phase 3, slice 3: context token metrics

Status: implemented · Branch: `feat/phase-3-03-context-metrics` (stacked on slice 2) · Spec: §16 Phase 3 go/no-go, §17 · ADR: 0044

The Phase 3 go/no-go asks for at least 30% fewer input tokens per Task without a drop in PR acceptance. Slice 2 records what the compiler produced; this slice reads it against what the agents consumed, so a campaign can run the same tasks with `knowledge.context.enabled` off and on and get a verdict.

## Behavior

- Each finished agent attempt knows whether it carried a block: the `context.compiled` event recorded for its task after the task's previous attempt ended gives `AttemptRecord.context_tokens` (null without one).
- `MetricsView.knowledge` (`KnowledgePanel`), computed on read in `apps/daemon/src/budgets/knowledge.ts` over the metrics window, for the profiles that can get a block (`triager`, `planner`, `implementer`, `researcher`, `lead`):
  - per profile and overall, two groups, **with** and **without** the block: attempts, succeeded, success rate (rate limits and cancellations left out, as elsewhere) and the **median input per attempt**, fresh plus cached input tokens;
  - `reduction` = 1 − median with / median without, reported only with at least 3 attempts on each side;
  - the block's own size (`context.median_est_tokens`);
  - PR acceptance (merged / closed) for runs whose comparable attempts all had a block or none; mixed runs count in neither;
  - `verdict`: `insufficient` until `reduction` exists, `met` when it reaches 0.3 and success and PR acceptance with the block are not below those without it, else `not_met`.
- `navarch metrics` prints the panel after the quality tables; the concierge's `show_usage` and the Web UI do not show it yet.

## Acceptance

- Three attempts with the block and three without, with medians 65,000 and 100,000 input tokens, give a reduction of 0.35 and `met`.
- Cached input counts: 10,000 fresh plus 40,000 cached is 50,000.
- A reduction of 0.5 with a lower success rate, or lower PR acceptance, is `not_met`.
- An end-to-end run with the block enabled shows one attempt with the block and the block's size, verdict `insufficient`.

## Not in this slice

- A Web UI tab, push or concierge answer for the panel.
- Balancing the campaign: the same tasks must be run on both sides by the operator; the panel compares what ran, it does not make the sides comparable (🟡).
