# 0038 — Public site: landing, docs and install page

- Status: accepted
- Date: 2026-10-17
- Builds on: ADR 0017 (Web UI stack), ADR 0018 (MIT license, public repository)

## Context

Navarch is public and open source, but the only way to learn about it is the README and `docs/`, which are written for contributors. The user asked for a public website like those of comparable tools (onorca.dev, opencode.ai, openclaw.ai, kilo.ai). It should have an animated landing page, docs and a download page, link to GitHub, and have **no sign-in**. Navarch is local-first: the daemon and the tokens stay on the user's machine, so a hosted account or dashboard would contradict it.

## Decision

1. **`site/` in this repository**, as the workspace package `@navarch/site`, so the site changes in the same pull request as the features it describes.
2. **Vue 3 + Vite + Tailwind 4**, the same stack and versions as `apps/web` (ADR 0017), with the Web UI's palette. It is a static SPA with no backend and no API calls. Routes are `/`, `/download` and `/docs/<page>`.
3. **Docs written for the site** in `site/src/docs/*.md`, rendered to HTML at build time by a small Vite plugin (markdown-it, a dev dependency only), so no Markdown parser ships. They are a user guide, shorter than `AGENTS.md` and the spec, and they must be kept in step with features by hand (see Consequences).
4. **GitHub Pages**, deployed by `.github/workflows/pages.yml` on pushes to `main` that touch `site/`, at `https://nadezhdkov.github.io/nav/` (`SITE_BASE=/nav/`). Pages has no SPA fallback, so the build writes one `index.html` per route plus `404.html`. Actions are pinned by commit SHA, like the other workflows.
5. **Accessibility and motion.** Status pairs an icon with a word, tabs are keyboard-operable, and the hero animation has a pause button and stops when the tab is hidden. With `prefers-reduced-motion`, everything shows its final state with no animation.
6. **Install from source** on the download page until packages exist. Publishing packages or registering a domain stays the user's decision (`AGENTS.md`).

## Consequences

- `make site-build` and `make site-dev` exist. `make typecheck` and CI also type-check and build the site.
- 🔴 The docs can drift from the code. A slice that changes user-facing behavior should update the matching page in `site/src/docs/`. The "Edit this page" link on every page makes fixes cheap.
- 🔴 Pages must be enabled once by the user (Settings → Pages → Source: GitHub Actions). Until then the deploy job fails.
- The screenshots in `site/public/shots/` are copies of `docs/assets/screenshots/`, so updating one means updating both.
