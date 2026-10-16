# 0037 — PR outcomes and the cost and quality panels

- Status: accepted
- Date: 2026-10-16
- Spec: §6.15 (Observability), §16 (Phase 2), §17 (success metrics)
- Slice: [`docs/specs/phase-2-07-cost-quality-panels.md`](../specs/phase-2-07-cost-quality-panels.md)
- Builds on: ADR 0023 (Cost Ledger and observed metrics), ADR 0021 (Inbox polling)

## Context

The quality panel of §6.15 asks for the accepted PR rate and rework, and §17 sets targets for both: ≥ 50 % of PRs accepted, < 25 % needing more than two rounds of adjustment. Navarch records the PRs it opens but never learns what became of them. There is no webhook (it comes later, with the relay), so knowing means asking GitHub.

"Accepted" and "round of adjustment" also need a definition that can be measured without reading the user's mind.

## Decision

1. **Poll the PRs Navarch opened until they close.** A PR watcher in the daemon reads each open one through the GitHub Integration on the Inbox's schedule (`inbox.poll_minutes`) and on `navarch sync`. It only reads. When the PR is closed it records one event, `github.pr.closed`, and stops following it. A PR is judged once: a reopened PR is not followed again.
2. **Accepted means merged.** Closed without merging is rejected. Open PRs are left out of the rate until they close.
3. **A round of adjustment is a commit added after Navarch's last push**, counted with GitHub's compare (`ahead_by`) between that commit and the PR's final head. `commits_after = 0` is "accepted as is", the measure the Phase 1 go/no-go used. Rework is `commits_after > 2`.
4. **Panels are computed on read** from projections (`usage`, `attempts`, the new `pull_requests`), like the existing metrics, with no stored aggregates. One route, `GET /api/v1/metrics`, serves both panels. Paired devices may read it.

## Consequences

- The quality panel covers PRs opened from now on, and older ones once the projections are rebuilt from their `github.pr.opened` events (upgrades do this).
- Each open PR costs one GitHub request per poll, and one compare when it closes. That is small next to the Inbox's issue listing.
- Squashed or force-pushed fix-ups count as fewer rounds than they were, and many small commits as more. The ADR keeps the simple measure until review rounds are needed (open item in the slice).
- The acceptance rate is there for learned routing (§19, item 4) to use later.
