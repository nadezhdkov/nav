# 0029 — Parallel team members, each in its own worktree, merged back by an integrate step

- Status: accepted
- Date: 2026-10-16
- Spec: §6.5.1, §6.5.2 ("integração de ramos paralelos"), §9.2 (`parallel`/`join`), §16 (Phase 2), §17 (risk "conflitos entre ramos paralelos")
- Slice: [`docs/specs/phase-2-01-parallel-members.md`](../specs/phase-2-01-parallel-members.md)
- Builds on: ADR 0011 (Flow engine), ADR 0022 (Team mode, §4 left parallel members to Phase 2)

## Context

In Team mode (ADR 0022) members run one at a time in the run's shared worktree, `navarch/<run>/team`. A plan with independent members (`ui` and `api`, neither depending on the other) waits for each in turn, although the plan format already says what may run together (`depends_on`). Running them at once in the same directory would let two agents edit the same files and see each other's half-done work.

The spec's answer (§6.5.2) is one worktree per parallel branch and an `integrate` step that merges the branches back one after another, calling an `implementer` when a merge conflicts.

Two questions are open: where a member's branch starts, and how a conflict is resolved without an agent running `git`.

## Decision

1. **`parallel` on the `team` node.** `parallel: true` (the `team` Flow's param, default `true`) runs every member whose dependencies are done at once, up to `max_parallel` (default 3) per team, and within the daemon's `scheduler.concurrency`. `parallel: false` keeps the Phase 1 behaviour unchanged.
2. **Each parallel member gets its own worktree**, `navarch/<run>/team-<key>`, in the usual sandbox directory (spec §6.5.2 naming). It **forks from the shared branch's HEAD when it starts**, after Navarch commits what is uncommitted there, so it sees the lead's edits and the merged work of the members it depends on. This departs from "parallel branches start from the run's base commit" (§6.5.2): a member that depends on another must see that work. Members with no dependencies in the same turn still fork from the same commit. The member's diff is measured from its fork point.
3. **Integrate is a task per editing member.** When an `implementer` member succeeds, the Flow engine creates `team.<key>.integrate` (action `team.integrate`). It commits the member's worktree as Navarch and merges its branch into the shared worktree with `git merge --no-ff`. Integrations of a team run one at a time, in the order the members finished. Read-only members (`planner`, `researcher`, `reviewer`) are not merged.
4. **A conflict goes to an implementer, and git stays with Navarch.** On a conflict the merge is left in progress in the shared worktree and the engine creates `team.<key>.resolve`, an `implementer` routed like any member, whose brief lists the conflicted files and both sides' intent. The agent edits files only. A second integrate attempt then checks the files for conflict markers and either concludes the merge as Navarch or aborts it. A member whose merge was aborted counts as not done: its dependants are not started, and the lead reads "merge conflict not resolved" in its next turn, as for a failed member. One resolve attempt per member.
5. **Dependencies mean merged.** In a parallel team, an editing member is done for its dependants when its branch is merged, not when its agent finished. The lead's turn, the verification and the review run in the shared worktree after every integration of the turn.
6. **Policy.** `team.integrate` is a new policy action, allowed from autonomy level 2 (it edits the run's own worktree) and asking a human below, like `verification.run`. The resolve agent is a `team.delegate`. Nothing pushes: the PR still carries only the shared branch.

## Consequences

- Teams with independent members finish sooner. Each member worktree runs the project's `setup` commands once (e.g. `npm ci`), which costs disk and time per member.
- Member worktrees and branches are kept until the run ends, for inspection (§6.5.2). The Worktree tab of a member's panel reads its own worktree (`GET /api/v1/runs/:id/worktree?task=`); the run's default stays the shared one.
- Budgets are checked when each agent is dispatched. Billed members running at once split what is left of the budget instead of each getting all of it (ADR 0030).
- `TeamTaskRef.role` gains `integrate`, `TeamMemberView` gains `merge` (`pending`, `merging`, `resolving`, `merged`, `conflict`) and `branch`. No new event types: integrations are tasks, and their outcome is the task's output.
- Generic `parallel`/`join` Flow nodes, the Compete mode and `judge` (spec §16) reuse the same worktree fork and integrate steps in later slices.
