# 0046 — Navarch as a read-only MCP server over the Core API

- Status: accepted
- Date: 2026-10-19
- Builds on: spec §9.5, ADR 0042 (code index), ADR 0043 (context compiler), ADR 0045 (specs)

## Context

Spec §9.5 wants external agents (Claude Code, Codex…) to call Navarch's knowledge, for example `navarch.search_specs`. The context block of ADR 0043 did not cut input tokens on small tasks (+9 %, Phase 3 report), and an agent that asks for what it needs may do better than a fixed block. Giving agents read access also has to keep the architecture rules: surfaces talk only to the Core API, content from repositories is untrusted.

## Decision

1. **A stdio server that is a surface, not a core.** `@navarch/mcp-server` speaks JSON-RPC 2.0 over newline-delimited stdio (MCP protocol 2025-06-18, falling back to the client's older supported version) and holds no logic: each tool is one `GET` on the Core API for one project. It uses no SDK, since the subset needed (`initialize`, `ping`, `tools/list`, `tools/call`) is small. `navarch mcp [--project <id>]` runs it, taking the project of the current directory like `navarch map`, and authenticates with the daemon token the CLI already reads.
2. **Read-only tools only:** `repo_map`, `repo_symbols`, `repo_search`, `specs_query`, `context_compile`, all marked `readOnlyHint`. Tools of §9.5 that act (`repo.edit`, `cmd.run`, `github.*`) are not exposed: they would need the Policy Engine and a run to answer to.
3. **Two new routes** feed it, readable by paired devices like the other exploration routes: `GET /api/v1/projects/:id/context?task=` (the compiler of ADR 0043, on demand and regardless of `knowledge.context.enabled`) and `GET /api/v1/projects/:id/specs?q=` (lines of `.navarch/specs/*.md` of the clone containing every word; regular files only, so a symlink in the repository cannot lead outside it).
4. **Results are data.** The server's `instructions` and every tool say so; the text comes from the repository.

## Consequences

- 🟡 `specs_query` reads the clone's working tree. Specs from `reverse-spec` sit on a local run branch until a PR path exists, so it finds none until they are merged into the project.
- 🟡 One project per server process, chosen at start.
- 🔴 No MCP resources, prompts or HTTP transport; no per-tool policy decision or event, since nothing is written.
