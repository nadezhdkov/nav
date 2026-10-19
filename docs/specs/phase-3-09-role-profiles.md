# Phase 3, slice 9: role profiles for team members

Status: implemented · Branch: `feat/phase-3-09-role-profiles` · Spec: §6.3.3, ADR 0022 · ADR: 0050

A team lead can staff its team by role: `architecture`, `frontend`, `backend`, `devops` and `qa`, besides `planner`, `researcher`, `implementer` and `reviewer`.

## Behavior

- `TeamMemberProfile` accepts the five new profiles; any other name is still refused.
- `architecture` is read-only (`edits: false`, tier `expert`). The other four edit like the `implementer` (tier `standard`) and are in `IMPLEMENTING_PROFILES`.
- In a parallel team an editing role works in its own worktree and is merged back by `team.<key>.integrate`; `architecture` is not merged.
- The lead's instructions describe every role and say to use `implementer` when none fits.
- Routing treats the editing roles as the `implementer`: complexity ≤ 2 goes to `fast`, a failed check escalates the tier, the compiled context applies, and the reviewer's provider differs from theirs.
- Cards and the Fleet tree show the role with its own icon.

## Acceptance

- `parseTeamPlan` accepts a plan with one member per role and refuses an unknown one.
- The engine merges a `frontend` and a `qa` member back one at a time and does not merge an `architecture` member.
- Every profile a lead may name exists, with the right `edits` flag and rules of its own; each role has a default tier.

## Not in this slice

- A role leading sub-agents of its own (two-level teams), user-defined profiles, per-role budgets or quotas.
