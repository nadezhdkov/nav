# 0050 — Role profiles for team members

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0022 (Team mode), ADR 0029 (parallel members), spec §6.3.3

## Context

A team lead (ADR 0022) could give a member only `planner`, `researcher`, `implementer` or `reviewer`. The user wants teams staffed by role (architecture, front end, back end, devops, QA), as in a project manager with specialist agents under it. A role is a discipline with its own working rules; it is not a new kind of permission.

## Decision

1. **Five new built-in profiles**, all members a lead may name in the `navarch-team` block:
   - `architecture` (tier `expert`, read-only): designs modules, interfaces and trade-offs for the other members to build, with evidence.
   - `frontend`, `backend`, `devops` and `qa` (tier `standard`): implementers by discipline. They edit the worktree like the `implementer`, plus the habits of their role. `qa` changes test files only and reports production bugs instead of fixing them. `devops` never deploys, publishes, tags or releases.
2. **A role changes the instructions, never the grant.** The tool grant still comes from `edits` and the run's allowlist, so autonomy levels, protected paths and the policy actions (`task.start`, `team.integrate`) treat a role exactly as they treat an `implementer`. `IMPLEMENTING_PROFILES` in `@navarch/contracts` is the one list of profiles that implement.
3. **Everything that keyed on `implementer` uses that list:** parallel members get their own worktree and are merged back (`team.<key>.integrate`), routing escalates them after failed checks and sends simple work to `fast`, they receive the compiled context, the reviewer avoids their providers, and the Away approver reads their summaries as the implementation. The Model Router has no dependencies, so it keeps its own copy of the names; a test keeps it equal to the list.
4. **The lead is told the roles** in its instructions and uses `implementer` when no role fits. The Fleet tree and cards show the role as the member's profile, with an icon per role.

## Consequences

- 🟡 One level only: a role does not lead sub-agents of its own (Backend → User Service, Order Service). The Team node stays a single level; nesting changes the engine and needs its own ADR.
- 🟡 Roles are fixed in code. User-defined profiles (a name, instructions, tier and edit flag in config) would be a later slice.
- 🟡 Two roles editing the same files in parallel still conflict at merge, and the existing resolver handles it.
