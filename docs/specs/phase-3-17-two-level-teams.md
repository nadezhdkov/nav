# Phase 3, slice 17: two-level teams (sub-leads)

Status: implemented · Branch: `feat/phase-3-17-two-level-teams` · Spec: ADR 0022, ADR 0029, ADR 0050, ADR 0051 · ADR: 0058

A team lead may give a member the profile `sublead`. The sub-lead leads a small team of its own on one part of the task, and the result merges into the lead's worktree like an editing member's.

## Behavior

- `TeamMemberProfile` gains `sublead` (tier `expert`, edits). The member's `brief` is the sub-lead's assignment.
- A sub-lead's team is a team node inside the main one: tasks `<team>.<key>.lead`, `<team>.<key>.<member>`, `<team>.<key>.<member>.integrate|resolve`, `<team>.<key>.verify`; the task `<team>.<key>` (action `team.subteam`) closes it. Tasks carry `TeamTaskRef.sub`.
- Worktrees: the sub-lead works in `navarch/<run>/<flow>-<key>`, forked from the run's; each of its members in `…-<key>.<member>`, forked from the sub-lead's and merged back into it (`team.integrate`, conflicts resolved as in ADR 0029). When the sub-lead's team ends, its worktree merges into the run's like any editing member.
- Limits: one level (a sub-lead's plan may not contain sub-leads, `parseTeamPlan` `nested`), at most 3 sub-leads per team, 4 turns and 6 members per sub-team; sub-leads need a parallel team. Member keys may not be `lead`, `verify`, `approve_plan`, `integrate` or `resolve`.
- A sub-lead may ask a `question`; the user answers as for the main lead. The first-plan approval is the main team's only.
- Sub-leads and their members are routed like members (the lead's `prefer` counts for the sub-lead). Their failures advance the Flow instead of failing the run (`flowDecidesFailure`).
- The lead's prompt says when to use a sub-lead; the sub-lead has its own profile.

## Acceptance

- Engine: a sub-lead's lead turn starts in its worktree beside an ordinary member; its members run in worktrees of their own, are merged into the sub-lead's, and the sub-team closes (`packages/flow-engine/test/team-sublead.test.ts`).
- Daemon: with a fake lead, sub-lead and two implementers, the run ends `done`, the shared worktree holds both members' files, each agent ran in the worktree named above (`apps/daemon/test/team.test.ts`).
- `parseTeamPlan` refuses a reserved key and a nested sub-lead.

## Not in this slice

- A sub-lead's own sub-leads, a sub-lead's quota-aware choice of the members' agents beyond routing, collapsing a sub-team in the UI, prompting a sub-team as a whole.
