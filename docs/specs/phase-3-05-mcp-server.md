# Phase 3, slice 5: Navarch as an MCP server

Status: implemented · Branch: `feat/phase-3-05-mcp-server` · Spec: §9.5, §16 Phase 3 · ADR: 0046

External agents read a project's code index, specs and compiled context through MCP.

## Behavior

- `navarch mcp [--project <id>]` serves MCP on stdio for one project (default: the one containing the current directory). Add it to an agent as a stdio server with command `navarch mcp`.
- Tools, all read-only: `repo_map`, `repo_symbols {query, kind?}`, `repo_search {query}`, `specs_query {query}`, `traceability` (ADR 0054), `context_compile {task}`. A failing call is a tool result with `isError`, a missing argument is `-32602`.
- API: `GET /api/v1/projects/:id/context?task=`, `GET /api/v1/projects/:id/specs?q=` (devices may read them); `searchSpecs` in `@navarch/knowledge`.

## Acceptance

- Against a running daemon, `initialize`, `tools/call repo_symbols` and `context_compile` answer with the project's real results.
- Unit tests cover the protocol, argument encoding, errors and split chunks; `searchSpecs` ignores symlinks.

## Not in this slice

- Acting tools (`repo.edit`, `cmd.run`, `github.*`), resources, HTTP transport, specs from run branches, REA tools.
