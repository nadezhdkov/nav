# 0027 — Run codenames

- Status: accepted
- Date: 2026-10-15
- Spec: §4 (glossary, Run), §8.4, §10
- Builds on: ADR 0002 (event store), ADR 0017 (Web UI)

## Context

Run ids are ULIDs (`run_01M50H812NB09ZCJ6WXTRT7XCQ`): unique and sortable, but hard to read, say or type. The user asked for names in the style of Android's dessert releases, themed for the project, and chose a codename with no hint of the task over a slug of what the run does (2026-10-15).

## Decision

- **Every run gets a codename**: an adjective and a ship of the fleet, `brave-frigate` (64 × 64 = 4,096 pairs, `apps/daemon/src/orchestrator/names.ts`). It is derived from the run id with SHA-256, and a pair already taken gets the next number (`brave-frigate-2`).
- **It is recorded in `run.created`** (`name`), so it never changes. Runs from before names have none in their event; the projection derives theirs from the id, so they keep the same name across rebuilds. Two older runs may share one, and lookups take the newest.
- **The id stays the identifier**: events, branches (`navarch/<run-id>/…`), worktrees, logs and links keep it. The name is `RunView.name`.
- **Names work wherever ids do in the API**: a hook on `/api/v1/runs/:id…` resolves a name to its run, or answers 404 "no run named …". So `navarch run show brave-frigate`, `navarch logs brave-frigate -f` and `navarch say brave-frigate …` all work.
- **Surfaces lead with the name**: the Web UI's run title (run list, run detail, Fleet, sidebar) is `name · issue · first prompt line`. The CLI's `run list` has a NAME column and `run show` prints `name (id)`. Push notifications start with the name.

## Consequences

- People can refer to runs by a word pair, in the UI, the terminal and conversation.
- A name tells nothing about the task. The issue and prompt still follow it in every title.
- Opening a database from before names rebuilds its projections once, as for every added column.
