# 0042 — Explorer code index without a parser dependency

- Status: accepted
- Date: 2026-10-17
- Builds on: ADR 0002 (no build step), ADR 0021 (projects)

## Context

Phase 3 (spec §16) starts with the Explorer's always-available code exploration (§6.9.1): a repository map, symbol search and "where is this implemented?". The spec names tree-sitter and ripgrep (§12). tree-sitter needs native addons or WASM grammars per language, which means a new dependency family, install-time downloads and a build step that ADR 0002 avoids so far.

## Decision

1. **A new package, `@navarch/explorer`**, with no runtime dependency beyond Node. It reads files tracked by git (`git ls-files`, so `.gitignore` is respected) and never writes to the repository.
2. **Line-based symbol extraction** for TypeScript/JavaScript, Python, Go and Rust (declarations: functions, classes, interfaces, types, enums, constants, methods). Every symbol carries `file`, `line`, `kind` and `lang`, so any answer has evidence (🟢). It is behind a `SymbolExtractor` interface per language, so a tree-sitter extractor can replace one language at a time.
3. **Search is ripgrep when present, a Node scan otherwise**, with the same result shape.
4. **Read-only and on demand.** The index is computed from the clone's working tree when asked, cached in memory by `HEAD` commit plus the status hash, and not stored in the event store. Nothing here is an event yet; the context compiler (next slice) decides what to persist.
5. Daemon routes and CLI commands are thin wrappers; paired devices may read them.

## Consequences

- 🟡 Line-based extraction misses multi-line declarations and nested scopes; it is a first cut, labelled as such in the answers.
- 🔴 Call and module graphs wait for a real parser.
- No new install-time risk; replacing extractors later does not change the API.
