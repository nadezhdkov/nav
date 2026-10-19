# Phase 3, slice 10: groups of team members

Status: implemented · Branch: `feat/phase-3-10-two-level-teams` · Spec: ADR 0022, ADR 0050 · ADR: 0051

A lead can put related members in a named group, and the Fleet tree draws lead → group → members.

## Behavior

- `TeamMemberSpec.group` (optional, `[a-z0-9][a-z0-9-]{0,31}`) in the `navarch-team` block; a malformed one makes the plan invalid, and the lead is told why.
- `TeamMemberView.group` carries it to the UI (`null` when absent).
- Fleet tree: a group heading per distinct group of a run, between the lead and its members, with the name, the agent count and the worst member state; ungrouped members stay under the lead.
- Execution, dependencies, merging and routing do not look at the group.

## Acceptance

- `parseTeamPlan` reads the label and refuses `Back End`.
- A fake lead's plan with `group: "backend"` reaches `RunDetail.team.members[0].group`.
- `buildFleetTree` hangs grouped members under their heading under the lead, keeps ungrouped ones under the lead, and keeps the `after` and `reports` edges.

## Not in this slice

- Sub-leads (a role running its own turns and delegating), folding a group, prompting a group, a screenshot-backed visual baseline.
