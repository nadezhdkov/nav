# 0030 — Running billed agents hold their share of the budget

- Status: accepted
- Date: 2026-10-16
- Spec: §6.1.4 (Cost Ledger and budgets)
- Builds on: ADR 0023 (budgets count billed use), ADR 0029 (parallel team members)

## Context

A billed agent starts with a spending cap: everything left of the smallest budget it counts towards (run, project day, global month). Claude Code gets it as `--max-budget-usd` and the `native` agent stops when it crosses it.

Each agent got the whole amount left. Two billed agents running at once, such as two parallel team members (ADR 0029) or two runs that share the global month, could each spend all of it, so together they could spend twice the budget. OpenCode, which is billed, had no cap at all.

## Decision

1. **A running billed agent holds its cap.** When the Scheduler dispatches an agent whose use is expected to be billed, Budgets records its cap against every limited scope of its run. The hold is released when the task ends. What the agent spent is already in `used`, so the hold counts only the part not spent yet (`cap − spent`). Holds live in daemon memory, like the running tasks; a restart requeues those tasks.
2. **A new agent gets an equal part of what is not held.** Its cap is what is left, less what running billed agents hold, divided by one plus the billed agents ready to start that share one of its scopes. It is rounded down to the cent. Members dispatched together therefore split the budget evenly, and the caps of agents running at once never add up to more than what is left.
3. **Nothing left to give: wait, do not ask.** When less than one cent is free and running agents hold the rest, the task stays `ready` and starts when one of them ends. A used-up budget still asks a human (`budget.exceed`, ADR 0023), as before.
4. **Billed means expected to be billed.** An adapter that declares `billing: metered` (`native`, `opencode`), or whose latest recorded use was billed (Claude Code on an API key), holds budget. Agents on a plan hold none and are bounded by quotas.
5. **The Model Router sees what is free.** Routing skips a metered candidate whose expected cost exceeds what is not held, instead of the whole amount left.
6. **OpenCode gets a cap.** It has no spending flag, so its adapter adds up the cost of each step it reports and stops the process after the step that crosses the task's cap, failing with `budget_exceeded`.

## Consequences

- Parallel billed members no longer spend beyond the run's budget together. Two runs sharing the global month or a project day no longer do either.
- Caps are enforced by the agents after each model call or step. An agent can therefore go past its own cap by its last call, as before this change. The sum of caps never goes past the budget.
- A billed member may start with a smaller cap than it would have alone, and fail with `budget_exceeded` where it used to finish. Raising the run budget, or running fewer members at once (`max_parallel`), gives each more.
- A task waiting for held budget shows as `ready` with nothing running for it. Showing the reason in the UI is open.
