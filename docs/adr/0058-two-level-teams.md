# 0058 — Two-level teams (sub-leads)

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0022 (Team mode), ADR 0029 (parallel members), ADR 0050 (role profiles), ADR 0051 (member groups)

## Context

ADR 0051 drew roles as groups but left real sub-leads for later: a role that runs its own turns and delegates. The user asked for them after groups proved insufficient for large tasks, where one lead cannot hold every brief in its head.

## Decision

1. **A `sublead` member profile.** A lead adds it like any member; the brief is its assignment. It leads a team of its own, run by the same engine functions as the main team (`teamStep` with a `Nest`), so turns, plans, checks, integration and conflict resolution behave the same. The sub-team's tasks are named `<team>.<key>.…` and carry `TeamTaskRef.sub`; the engine still derives everything from tasks.
2. **Worktrees nest.** The sub-lead owns a worktree forked from the run's; its members fork from it and merge into it with `team.integrate`; the sub-lead's work then merges into the run's. `ownWorktreeKey` gives `<key>` and `<key>.<member>`, and the Scheduler forks from the matching parent.
3. **One level, bounded.** Sub-leads cannot have sub-leads; at most 3 per team, 4 turns and 6 members per sub-team, and only in parallel teams. The first-plan approval stays with the main team.
4. **Closing task.** `team.<key>` (action `team.subteam`, policy always allow) records that a sub-team ended, with its summary or failure; the parent treats it as the member finishing. A failed sub-team does not fail the run.
5. **No new authority.** A sub-lead's grant is the lead's (`edits: true`, the run's allowlist); routing, budgets and the Policy Engine apply to its tasks as to members'.

## Consequences

- 🟡 Cost grows with depth: a sub-lead is an `expert` tier agent that takes turns. The caps keep it bounded, and budgets still count every task.
- 🟡 Reserved member keys are now refused, which also affects ordinary members that used them (none known).
- 🔴 No sub-sub-leads, no UI folding of a sub-team beyond what the Fleet tree draws.
