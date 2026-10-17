# Phase 3, slice 1: code index and repository map

Status: in progress · Branch: `feat/phase-3-01-code-index` · Spec: §6.9.1, §16 Phase 3 · ADR: 0042

The Explorer's always-available exploration: what a repository contains, where a symbol is defined, where a term appears. It is the base for the context compiler (slice 2).

## Behavior

- `@navarch/explorer` exports `repoMap(root)`, `indexSymbols(root)`, `findSymbols(index, query)` and `searchText(root, query)`.
- **Repository map**: languages (files and lines by extension, top 8), frameworks and tools detected from manifests (`package.json` dependencies, `pyproject.toml`, `go.mod`, `Cargo.toml`, Dockerfile, workflows), entry points (`package.json` `main`/`bin`/`scripts.start`, `main.*`, `cmd/*`), manifests and top-level directories with file counts.
- **Symbols**: `{ name, kind, lang, file, line, exported }` for TypeScript/JavaScript, Python, Go and Rust. Files over 512 KiB and binary files are skipped; at most 20,000 files.
- **Search**: `searchText` returns `{ file, line, text }` (text cut at 200 characters, 100 results), by ripgrep when installed, else a Node scan.
- `GET /api/v1/projects/:id/map`, `GET /api/v1/projects/:id/symbols?q=&kind=`, `GET /api/v1/projects/:id/search?q=`; paired devices may read them. Results are untrusted text from the repository.
- CLI: `navarch map [--project <id>]`, `navarch symbols <query> [--project <id>]`, `navarch where <query> [--project <id>]`.

## Acceptance

- The map of this repository names TypeScript as the main language, finds `pnpm` workspaces and lists `apps/*` and `packages/*`.
- `symbols parseTeamPlan` returns its definition in `packages/contracts` with the right line.
- Ignored files (`node_modules`, `.gitignore`d) never appear.
- The same results come back with and without ripgrep.

## Not in this slice

- Call and module graphs, semantic search, persistence, MCP tools, the context compiler.
