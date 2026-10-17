# 0039 — Away mode and the approver agent

- Status: accepted
- Date: 2026-10-17
- Builds on: ADR 0011 (Flow engine), ADR 0021 (Inbox triage on an API model), ADR 0022/0023 (budgets, approvals), `AGENTS.md` merge policy

## Context

Below autonomy level 3 every run stops for a human at the plan and at the draft PR. When the user is busy on another project, runs sit in `awaiting_approval` and the fleet idles. Autonomy level 3 removes the stops, but it is all or nothing: nobody reads the plan. The user asked for an in-between: "options to tick, with a clear warning", where an agent reads the plan, **asks for a redo if it is bad**, approves when it is good, and the run goes on to the PR. Merge stays out of it.

## Decision

1. **Away mode is an explicit, time-boxed opt-in.** `away.enabled` carries what is handed over (`plan`, `pr`, `start`), when it ends (`until`, default 4 h, or never), a complexity limit and how many times a plan may be sent back. Turning it on needs `confirm: true` (the Web UI shows the warning and a checkbox, the CLI asks or needs `--yes`). Only the user can do it, from the desktop or the CLI: the Policy Engine denies `away.set` to agents and to paired phones. It turns itself off at `until` (`away.disabled`, reason `expired`). Paired phones can read the state and see the banner.
2. **The approver is an API model on the native client, with no tools and no repository**, like the Inbox triage (ADR 0021): `away.model`, else the routed `native` entries of profile `approver` (tier `standard`). It reads a dossier (the request, the triage, the plan, and for the PR gate the implementation, verification and review summaries). All of it is untrusted data in delimited blocks, the answer is validated JSON cut down to an enum and short plain text, and anything unclear becomes `escalate`.
3. **Three verdicts.** `approve` decides the approval as the `approver` actor. `revise` is an approval that carries feedback (`approval.decided.revise`): the approval node ends with `outputs.revise`, and the Flow engine runs the node before it again (the planner, iteration + 1) with `revision_feedback` and `previous_plan`, then asks the approval again for the new plan (`reviseStep` in `packages/flow-engine`). No new state is added to the task or run machines. `escalate` leaves the approval pending for the user, who gets the usual push notification then (and not before).
4. **Hard rules sit outside the model.** The approver only sees approvals of kinds the user handed over: the plan gate (`flow.approval` of a node called `approve_plan`), `github.pr.create` and agent starts (`task.start`, `team.turn`, `team.delegate`). Budget exceedance, merges, PR comments and reviews, compete picks and everything else are never delegated. A run the triage rates above `max_complexity` is left to the user without asking a model, and so is a PR whose checks did not pass. The Policy Engine decides every delegation (`approval.delegate`: allowed only for the approver while the mode is on and the kind is handed over). A plan goes back at most `max_revisions` times (3 at the most, also capped in the engine), then the user decides.
5. **Everything is an event.** `away.enabled`, `away.disabled`, `away.reviewed` (approval, subject, verdict, reason, model, cost) and the `approval.decided` of the approver, whose actor says so. `GET /api/v1/away` derives the view (counts and the last 100 reviews) from them; `navarch away` and `/away` show it, and a banner stays on every screen while the mode is on.
6. **If the approver cannot work** (no API model, or no usable answer), the approval is left to the user and the reason is shown.

## Consequences

- 🟡 The approver is a model and can be wrong, which the warning says. What it approves is still a draft PR that the user reviews and merges.
- 🔴 Complexity is known only for runs with a triage (issue runs). A prompt run has none, so the limit does not apply to it.
- 🔴 The approver's cost is not counted against run budgets yet (it is recorded in `away.reviewed.cost_usd`). Free or cheap models are the intended use.
- 🔴 Not in this slice: starting runs on top of open PR branches ("stacking"), so the fleet does not wait for merges. It needs its own design (base branch, ordering, conflicts) and a follow-up slice.
- The `approver` profile exists only as a routing profile; it has no worktree and no Flow node.
