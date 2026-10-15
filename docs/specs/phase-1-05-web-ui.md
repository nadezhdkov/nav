# Phase 1, slice 5: Web UI (runs, live graph, approvals)

Status: implemented · Branch: `feat/web-ui` · Spec: §6.2.4, §6.13, §15.1, §15.2, §15.4, §16 (Phase 1 "Web UI") · ADR: 0017

`navarchd` serves a Vue 3 SPA (`apps/web`) that is a pure client of the Core API. This slice covers what Phase 1 asks for that already has data behind it: the run list, the run detail with a read-only live TaskGraph, and approvals. The Inbox waits for WorkItem sources (label triggers, webhooks).

## Behavior

```
$ navarch web            # opens http://127.0.0.1:7420/#code=… in the browser
$ navarch web --print    # prints the URL instead (the code works once, for 60 s)
```

- **Runs** (`/runs`, also `/`): newest first; status (icon + text), flow, prompt or issue, repository, cost vs. budget, age. Updates live from the `runs` topic.
- **Run detail** (`/runs/:id`):
  - top: title (issue or prompt), status, cost vs. budget, PR link, Cancel (any run not ended) / Resume (paused runs), exactly where the Orchestrator accepts them;
  - center: the run's Flow as a graph (Vue Flow, read-only), one node per Flow node, loop bodies grouped in a dashed lane with their iteration ("1 of 3", params resolved), each node showing its latest task's status (icon + text), adapter/model and iteration; long Flows wrap into rows instead of shrinking; running nodes pulse (off with `prefers-reduced-motion`); approval nodes and tasks waiting for approval use the amber "gate" style;
  - right, when a node is selected (click, or Enter/Space on a focused node): profile, adapter, model, attempt, iteration, cost, summary or error, artifacts (opened as text), and its routing decision (`model.routed`);
  - bottom: the event timeline, filterable by type, live from `run:<id>`, plus the live log tail.
- **Approvals** (`/approvals`): pending first, with what will happen (`summary`), why (`reason`), the run's cost vs. budget, a link to the run, and Approve / Reject with an optional reason. A nav badge counts pending approvals.
- Dark theme by default, a light theme follows `prefers-color-scheme: light`; contrast AA; every control reachable by keyboard; status never by color alone.

## Rules

- **Pure client** (rule 1): the SPA only calls `/api/v1/*` and `/api/v1/stream`; types come from `@navarch/contracts`. No business logic in components beyond presentation (e.g. building graph nodes from the Flow and tasks).
- **Auth**: every API call needs the local bearer token (unchanged). The SPA's static files are served without it. `navarch web` asks the daemon for a **single-use sign-in code** (`POST /api/v1/web/codes`, 60 s) and opens `#code=…`; the SPA trades it for the token (`POST /api/v1/web/exchange`, the one unauthenticated API route) and clears the fragment. The token itself never appears in a browser's command line, which other local users can read. The SPA keeps the token in `sessionStorage`. Without one it shows how to get it (`navarch web`) and a field to paste it; `#token=…` also works for scripts.
- **Static serving**: `navarchd` serves `apps/web/dist` (or `daemon.web_dir`) at `/` with an SPA fallback for non-API GETs and a strict Content-Security-Policy (`default-src 'self'`, `script-src 'self'`, `style-src 'self'`, no inline scripts or styles, no framing). Files are resolved per request, so `make web-build` takes effect without a daemon restart; `index.html` is `no-cache`, hashed assets are immutable. If the build is missing, `/` answers 503 with how to build it (`make web-build`).
- **Contract**: `RunDetail` gains `flow_definition` (the run's copy of its Flow and params), which the daemon already returns; the graph is built from it, not from `flows/*.yaml`.
- **i18n**: every UI string goes through `vue-i18n`, English base locale. Locales in `apps/web/src/locales/`: `en`, `pt-BR`, `es`, `de`, `zh-CN`, each typed against the English shape (a missing key fails `vue-tsc`, a changed placeholder fails a test). The UI starts in the viewer's saved choice, else the closest browser language, else English; the picker in the sidebar saves it in `localStorage` and sets `<html lang>`. Run, Flow and PR stay untranslated as glossary terms (§4), except Run in Chinese (运行). Text that comes from the daemon (event details, approval reasons, agent output) is not translated.

## Tests (no network, no real agent)

- `apps/web`: graph building from a Flow and tasks (linear flow, loop with iterations, skipped and pending nodes, approval gate); stores applying stream events; components with Vue Test Utils (run list renders status icon + text, approval decide calls the API, missing token shows the token screen).
- Daemon: static files and SPA fallback without a token, API still 401 without one, CSP and cache headers, files added after start, missing build message, sign-in code works once, `flow_definition` in the run detail.
- CLI: `navarch web` asks for a code and puts it, not the token, in the URL fragment.
- Visual check (2026-10-15): a demo daemon with the fake agent CLI and a six-node Flow, captured in Chromium at 1440×900 (dark and light) and 390×844; no console errors or CSP violations.

## 🔴 Open

- Inbox (§15.3) and Home (§15.1) wait for WorkItem sources and the Cost Ledger views.
- Pause (§9.1) is not in the API yet; only Cancel and Resume are shown.
- Instructions to a running run (`POST /runs/:id/messages`) and a concierge panel are later slices.
- WebAuthn re-authentication for sensitive actions (§6.12.3) comes with the PWA and remote access.
