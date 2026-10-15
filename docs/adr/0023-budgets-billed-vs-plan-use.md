# 0023 — Budgets count billed use; plan use is bounded by quotas

- Status: accepted
- Date: 2026-10-15
- Spec: §1.3 P3, §2.2 R2, §6.1.4, §6.4.2 (steps 3–4), §6.10.1, §9.2
- Slice: [`docs/specs/phase-1-11-budgets.md`](../specs/phase-1-11-budgets.md)
- Builds on: ADR 0005 (quota-aware retries), ADR 0013 (Model Router v1), ADR 0014 (free models)

## Context

Spec §6.1.4 asks for budgets per run, per project and day, and globally per month, with an alert at 80 % and an approval at 100 %. Until now only the run budget existed, and a run that used it up blocked its next task with no way out.

Most of Navarch's agents run on subscription plans. Claude Code reports an API-equivalent `total_cost_usd` even when it is signed in to a claude.ai plan; in the Phase 0 go/no-go that was $1.66 that nobody paid, and it counted against run budgets. Codex, Copilot, gemini-cli and antigravity report no cost at all. A budget that mixes both either stops runs that cost nothing or says nothing about the plans' real limits, which are quotas.

## Decision

1. Every usage record carries `billing: metered | plan`. Claude Code is `plan` when its init event says `apiKeySource: "none"`, `metered` otherwise; `native` and OpenCode are `metered`; the other CLIs are `plan`. Records from before this ADR count as `metered`.
2. Budgets (run, project/day, global/month) count only `metered` cost. Plan use is bounded by quotas (ADR 0005) and shown as a plan-equivalent figure.
3. Limits come from `budgets.*` in the config and from `budget.set` events made by the user (CLI or desktop UI); agents and paired devices cannot set them. Periods use the PC's local time.
4. `budget.threshold` is recorded once per scope, period and threshold (0.8, 1) and notified. At 100 %, starting an agent task needs approval (`budget.exceed`) and the run shows `budget_exceeded`; raising the budget releases waiting tasks.
5. The Model Router filters `metered` candidates whose expected cost (median billed cost of the entry's succeeded tasks for the profile, 30 days, at least 3) exceeds the smallest remaining budget, and moves candidates with a quota window at or above `routing.quota_reserve` or a high recent error rate after the others. These are the first `observed` metrics of §6.4.1, computed on read.

## Consequences

- Runs on subscription agents are no longer stopped by a money budget they do not spend; a team of plan agents can run long, limited by quotas and `max_turns`.
- A user who switches Claude Code to an API key gets budgets that count it, with no setting to change.
- Gemini with a paid API key reports no cost and is recorded as `plan` until the adapter can price tokens from configuration (🔴 in the slice).
- The spec's score function (`quality − λ·cost − μ·latency`) is still not used: tiers stay preference lists, adjusted by the demotions above.
