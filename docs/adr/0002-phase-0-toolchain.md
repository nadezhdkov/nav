# 0002 — Phase 0 toolchain: TypeScript without a build step, node:sqlite, no Drizzle or turbo yet

- Status: accepted
- Date: 2026-10-14
- Spec: §12.1, §19.2

## Context

The spec recommends TypeScript on Node 22 LTS with Fastify, SQLite (WAL) + Drizzle, Zod, Vitest, and pnpm workspaces + turbo. Phase 0 needs a working daemon, event store and CLI quickly, with few moving parts.

## Decision

- **Language:** TypeScript (spec §19.2 resolved in favour of the recommendation).
- **Runtime:** Node `>=22.18`, which runs `.ts` files directly through type stripping. Code uses only erasable syntax (`erasableSyntaxOnly`), imports use `.ts` extensions, and packages export their `src/*.ts` files. `tsc` runs with `noEmit` for type checking only.
- **SQLite:** the built-in `node:sqlite` module (no native addon to compile). The event store uses hand-written SQL for its three projection tables.
- **Drizzle:** deferred. It will be introduced when projections grow beyond a few tables (expected in Phase 1 with WorkItems, approvals and models).
- **turbo:** deferred. With no build step, one root `tsc` and one root `vitest` cover every package. turbo returns when `apps/web` adds a Vite build.
- **Package manager:** pnpm workspaces (`apps/*`, `packages/*`, `packages/adapters/*`).
- **Command entry point:** the root `Makefile`.

## Consequences

- No `dist/` folders to keep in sync; tests and the daemon run the same sources.
- Packaging as a single binary (spec §12.1, Node SEA) will need a bundling step later.
- Projections are rebuilt from the event log (`EventStore.rebuildProjections`), so moving them to Drizzle later needs no data migration.
