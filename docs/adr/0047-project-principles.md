# 0047 — Project principles: approved rules that every agent of a project follows

- Status: accepted
- Date: 2026-10-19
- Builds on: spec §6.8.3, ADR 0021 (projects), ADR 0043 (prompt blocks)

## Context

Spec §6.8.3 wants decisions the user makes ("in this repo, use Pest instead of PHPUnit") to become project rules in `.navarch/principles.md` and apply to later runs, only with the user's explicit confirmation. Agents today learn such conventions only from the task text or from the repository's own `AGENTS.md`, which each agent CLI reads in its own way (or not at all, since Navarch starts them without user-level settings).

## Decision

1. **Two sources, one list.** The user's approved rules live in the event store (`principle.added|removed`, projection `principles`), one line each. The repository may also list rules as top-level bullets of `.navarch/principles.md`. A project's rules are the user's first, then the file's, without repeats, at most 30 (`MAX_PRINCIPLES`).
2. **The file is read at the run's base commit**, like `project.yaml`, so an agent cannot change the rules that bind it during its own run. The user's list is not in the repository, so a run never writes it.
3. **Only the user changes the list.** Policy action `principles.set` is allowed for the user from the desktop or the CLI, and denied for paired phones and agents. Nothing proposes rules by itself in this slice, which keeps "explicit confirmation" literal: the user types the rule (`navarch principles add`, optionally `--run` to say which run's decision it came from).
4. **Every agent prompt** gets a `<principles>` block after the task, rendered by `buildInstructions`. The block says the rules do not change the allowed commands or the profile's rules. A rule is one line, at most 300 characters, and `<` is escaped.
5. **API:** `GET /api/v1/projects/:id/principles` (devices may read it), `POST` and `DELETE …/principles/:principle` (desktop and CLI only). CLI: `navarch principles [add <rule> [--run] | remove <id>] [--project]`.

## Consequences

- 🟡 The file's rules are repository content: anyone who can merge to the base branch can add one. They are bound by the same profile rules and command list as everything else in the prompt, and the user's rules come first.
- 🟡 The user's list is local to the Navarch home; it is not exported to `.navarch/principles.md` (the user can commit the file themselves).
- 🔴 No proposals from agents or the concierge, no Web UI screen, no per-profile rules, no weekly report line (§17.8).
