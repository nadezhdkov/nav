# 0054 — Traceability matrices over the specs

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0045 (traceable specs), ADR 0042 (code index), ADR 0046 (MCP server)

## Context

Spec §6.8.1 asks for traceability matrices: `code ↔ spec`, `spec ↔ test`, `bug ↔ spec`. The specs already cite code (`file:line`), so the first two can be computed from files alone; the third needs bugs tied to specs, which nothing records yet.

## Decision

1. **`traceability(root)`** (`packages/knowledge/src/trace.ts`) reads the component files of `.navarch/specs/` (not `index.md`, not the addenda, regular files only) and the files git sees, with no model call:
   - **`code ↔ spec`:** each code file a claim cites, with the claims (component, id, confidence, line); the source files no claim cites (first 200, plus the total); citations whose file or line is gone (`broken`); the share of source files cited.
   - **`spec ↔ test`:** for each claim, the code files it cites and the tests tied to them; the share of claims that cite a file and have a test.
2. **Test links are inferred, never confirmed.** A test is tied to a file when it has the same name (`auth.ts` ↔ `auth.test.ts`, `auth_test.go`, `test_auth.py`, `AuthTest.java`) or, for other files, when its text imports the module by path or Python `from/import`. Generic names (`index`, `main`, `mod`, `__init__`, `lib`, `app`, `utils`, `types`) are tied by name only. The output says "a test exists for this file", not that it proves the claim.
3. **Surfaces:** `GET /api/v1/projects/:id/traceability` (devices may read it), `navarch trace [--project]` and the MCP tool `traceability`. They read the clone's working tree, like the other exploration routes.
4. **Parsing the spec files:** the claims are read back from the lines `renderSpec` writes (`- 🟢 **id** text — \`file:line\``), so a hand-edited file that keeps that line shape counts.

## Consequences

- 🟡 The matrices describe the specs in the clone, so a project sees nothing until specs are merged into it (same as `specs_query`).
- 🟡 Name and import matching misses tests that reach a file through another module and can tie a test to a same-named file elsewhere.
- 🔴 `bug ↔ spec` is not built: it needs bugs recorded against specs (spec §19, item 10). No Web UI view of the matrices yet.
