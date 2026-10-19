# 0053 — A Specs screen in the Web UI

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0045 (traceable specs), ADR 0049 (`spec-sync`), ADR 0017 (Web UI)

## Context

What `reverse-spec` writes and how much of it the code confirms (the Phase 3 criterion, ≥ 70 % 🟢) was only visible through `navarch specs`, and the addenda written by `spec-sync` were visible nowhere but the run's events.

## Decision

1. **`/specs` in the Web UI** (desktop sidebar, between Flows and Usage): the latest extraction's confirmed share against the target, every extraction with a stacked bar (confirmed, inferred, gap) and its counts, and the addenda written after merges with their changes, stale claims and claims not found in the specs. Status is text as well as color. Each entry links to its run.
2. **API:** `GET /api/v1/specs` (unchanged) and the new `GET /api/v1/specs/addenda` (`SpecAddendumRunView`, newest first, 20), both readable by paired devices. `SPEC_GREEN_TARGET` (0.7) now lives in `@navarch/contracts` next to the coverage types.
3. **Live:** a `specs` store refetches on `spec.generated` and `spec.addendum.written`.
4. **Read-only:** the specs themselves live in the project's repository and reach it through a pull request; this screen changes nothing.

## Consequences

- 🟡 It shows the write each run produced, not the specs as merged in the repository today.
- 🟡 No tab for it on phones; the data is readable there, but the tab bar stays at five items.
- 🔴 No component-by-component view, no claim text, no traceability matrix.
