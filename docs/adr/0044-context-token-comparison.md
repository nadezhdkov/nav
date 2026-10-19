# 0044 — Context token comparison from observed attempts

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0043 (context compiler), ADR 0023 (token metrics), ADR 0037 (quality panels)

## Context

The Phase 3 go/no-go needs a measured token reduction without a drop in PR acceptance. Attempts already record tokens, and `context.compiled` records the block. Nothing yet joins them.

## Decision

1. **Compare attempts, not estimates.** The metric is the median of fresh plus cached input tokens per finished attempt, with the block against without it, for the same profile. The block's own estimate is reported but never counted as the saving.
2. **The join is by event order**: the `context.compiled` event of a task between its previous attempt's end and this attempt's end. No new column or event, so older data needs no migration.
3. **Computed on read** like the cost and quality panels, in a pure function over attempts and PRs, so the verdict rule is testable.
4. **The verdict is conservative**: it needs 3 attempts on each side, the 30% target, and success and PR acceptance with the block not below those without. Mixed runs are left out of the PR comparison.

## Consequences

- 🟡 The panel compares what ran. Different tasks on each side can move the medians; the campaign must run the same tasks on both sides.
- 🟡 Median input tokens include the cached part, which cheapens input on some agents; the cost panels still show money separately.
- 🔴 Acceptance needs merged or closed PRs, which arrive days later, so the verdict may wait on them after the token numbers are in.
