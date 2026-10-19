# 0051 — Groups of team members in the Fleet tree

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0022 (Team mode), ADR 0050 (role profiles), slice 10 (Fleet tree)

## Context

With role profiles (ADR 0050) a lead staffs a team by role, and the user's mockup shows the team as lead → roles → the agents of each role (Backend → User Service, Order Service). Real sub-leads, where a role runs its own turns and delegates, change the Team engine, the worktree forks and the merges, and were left for a later feature by the user's decision. What the mockup needs on screen can be had without that.

## Decision

1. **`group` on a team member:** an optional label (a lowercase word, same format as a member key) in the `navarch-team` block. Members with the same group are shown together. It is **presentation only**: it changes neither the order members run in, nor `depends_on`, nor worktrees, merges, routing or approvals, and it has no effect on grants.
2. **Fleet tree:** a member with a group hangs under a **group heading** that hangs under the lead (lead → group → members). The heading shows the group's name, the number of agents and the worst state among them. Members without a group stay directly under the lead, as before. `depends_on` edges, reports edges and the lead's internal sub-agents are unchanged. Cards still carry status, worktree, cost and the prompt box.
3. **API:** `TeamMemberView.group` (`string | null`).
4. **The lead's prompt** says what `group` is for and that it is display only; the natural value is the role's name.

## Consequences

- 🟡 A group is not an agent: it cannot be prompted, paused or given a brief, and nothing runs for it.
- 🟡 Groups are not folded yet; only runs and the lead's internal sub-agents fold.
- 🔴 Real two-level teams (a role leading sub-agents of its own, with its own turns, worktree and merge step) are a separate future feature.
