# Phase 3, slice 6: project principles

Status: implemented · Branch: `feat/phase-3-06-principles` · Spec: §6.8.3, §13.1, §16 Phase 3 · ADR: 0047

Rules the user approved for a project reach every agent of its later runs.

## Behavior

- `navarch principles add "<rule>" [--run <run>]` records a rule for the project of the current directory (`--project <id>` otherwise); `navarch principles` lists them; `navarch principles remove <id>`.
- `.navarch/principles.md` at the run's base commit adds its top-level bullets (`-`, `*`, `+`), one rule each.
- Every agent prompt carries `<principles>` after the task (user rules first, then the file's, at most 30); with no rules the prompt is unchanged.
- API: `GET /api/v1/projects/:id/principles` (devices may read it), `POST` and `DELETE …/principles/:principle` (desktop and CLI only; policy action `principles.set`). Events `principle.added|removed`.

## Acceptance

- A rule added through the API and a bullet committed in the file both appear in the prompt of a run's agent; a change to the file after the base commit does not.
- A phone or an agent cannot add or remove a rule; duplicates, multi-line rules and a 31st rule are refused.

## Not in this slice

- Proposals from agents or the concierge, a Web UI screen, per-profile rules, exporting the user's list to the file.
