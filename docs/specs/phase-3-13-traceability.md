# Phase 3, slice 13: traceability matrices

Status: implemented · Branch: `feat/phase-3-13-traceability` · Spec: §6.8.1 · ADR: 0054

`code ↔ spec` and `spec ↔ test` for a project's specs, computed from files with no model.

## Behavior

- `traceability(root)` in `@navarch/knowledge` returns `TraceabilityView`: `has_specs`, `components`, `code_spec` rows (file, claims, tests), `uncovered` source files (+ total), `spec_test` rows (claim, files, tests), `broken` citations and `totals` (cited share, tested share).
- Tests are tied to a file by name or by import (`via: "name" | "import"`); the links are inferred.
- `GET /api/v1/projects/:id/traceability` (devices may read it), `navarch trace [--project] [--json]`, MCP tool `traceability`.

## Acceptance

- Against a real repository: cited files carry their claims and tests (by name and by import); source files nothing cites are listed; tests, docs, `.navarch/` and `.d.ts` are not source; the index and the addenda are not components; a citation marked "not found" is `broken`.
- A repository without specs answers `has_specs: false` with all source files uncovered.
- The route and the CLI summary show the same numbers.

## Not in this slice

- `bug ↔ spec`, a Web UI view, languages whose tests reach code only through a build system.
