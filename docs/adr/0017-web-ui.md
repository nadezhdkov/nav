# 0017 — Web UI: a Vite-built Vue SPA served by navarchd, signed in with a single-use code

- Status: accepted
- Date: 2026-10-15
- Spec: §6.13, §12.1, §15, architecture rule 1
- Builds on: ADR 0002 (no build step for the Node sources)

## Context

Phase 1 needs a Web UI: run list, run detail with a read-only live graph, approvals (§16). The spec's stack is Vue 3 + Vite + Pinia + Vue Flow + Tailwind/shadcn-vue (§12.1). ADR 0002 runs every source on Node through type stripping, with no build step, and `make typecheck` uses TypeScript 7, which has no JavaScript API. Vue single-file components need a compiler, and `vue-tsc` needs the TypeScript JavaScript API. Every API call needs the local bearer token from `~/.navarch/token`, which a browser does not have.

## Decision

- **`apps/web` is the one package with a build step.** Vite builds it to `apps/web/dist` (`make web-build`; `make web-dev` runs the Vite dev server with `/api` proxied to the daemon). The Node packages keep running from source (ADR 0002).
- **`apps/web` type-checks with `vue-tsc` on its own TypeScript 6** (a dev dependency of that package only); the root `tsc` (TypeScript 7) excludes `apps/web`. `make typecheck` runs both.
- **Libraries**: Vue 3, vue-router, Pinia, `@vue-flow/core` for the graph, Tailwind CSS 4 through its Vite plugin, `vue-i18n`, Lucide icons. shadcn-vue is deferred: it copies component sources into the repo, and this slice needs only a handful of plain components.
- **`navarchd` serves the build** at `/`, without a token, with an SPA fallback and a strict CSP (`script-src 'self'`, `style-src 'self'`, no framing). `/api/*` keeps requiring the token. Files are resolved per request, so a rebuild needs no restart.
- **Sign-in with a single-use code.** `navarch web` asks the daemon for a random code (`POST /api/v1/web/codes`, 256 bits, valid 60 s, held in memory) and opens `http://<daemon>/#code=<code>`. The SPA trades it for the token at `POST /api/v1/web/exchange`, the one API route without a token, and clears the fragment. A browser started with a URL keeps it in its command line, which other local users can read in `/proc`; a used or expired code is worthless there, while the token would not be. The fragment never reaches the server or its logs. The SPA keeps the token in `sessionStorage` and sends it as `Authorization: Bearer` and as the stream's `?token=` (already accepted). No cookie, so no CSRF surface; the CSP and Vue's escaping guard the token against injected scripts. Remote access (PWA, Tailscale) brings device pairing and WebAuthn (§6.12.3) and will revisit this.
- **The graph comes from the run's own Flow copy** (`RunDetail.flow_definition`), so a run renders as it was started even if `flows/*.yaml` changes.
- **Visual reference**: dark grid canvas, glowing active nodes, dashed lanes for loops, an amber approval gate, a side panel for the selected node (in the spirit of archify diagrams, reference only; no code copied).

## Consequences

- CI installs and builds one more package; `make verify` grows by the web type check and tests.
- Two TypeScript versions live in the lockfile until `vue-tsc` supports TypeScript 7.
- Anyone who can read `~/.navarch/token` can still use the UI, as with the CLI; the browser keeps the token only for the tab's session.
