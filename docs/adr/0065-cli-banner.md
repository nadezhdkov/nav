# 0065 — The CLI banner

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0063 (phone chat and the first CLI banner), ADR 0016 (concierge)

## Context

The first banner (ADR 0063) was a small ASCII ship. The user found it plain and ugly and sent a mock-up: a pixel-art mascot at the left, a helm wheel and the name in large letters, the tagline, six lines about where you are, `System ready` and a `nav>` prompt.

## Decision

1. **Mascot as data.** A palette-indexed grid (`mascot.ts`) printed with `▀`/`▄` half-blocks and 24-bit colour: two pixels per text row, no image file and no dependency. It is shown only when `COLORTERM` says true colour and the terminal has at least 78 columns; otherwise it is left out rather than shown badly.
2. **The name** in a 5-row block font beside a helm wheel; below 54 columns, plain text.
3. **Where you are**, each line read quickly and left out when unknown: the registered project (else the repository folder), the `origin` remote shown as an `https` link **without credentials**, the workspace with `~`, the git branch, and the agents running or waiting (from `GET /api/v1/fleet`). Values are stripped of control characters and cut to the width.
4. **Order.** The chat opens its conversation first, then prints the banner with `System ready`, so a daemon that is not running shows its error and no banner.
5. **Prompt** `nav>` in colour on a terminal; the plain `navarch>` stays without one, so scripts and tests keep their output.
6. **No model row.** The mock-up's "AI Model" is left out: the concierge picks its model per message, so the banner could only guess.

## Consequences

- 🟡 The mascot was drawn by hand from the mock-up and checked in a browser rendering, not in every terminal font; line height gaps in some terminals show seams between rows.
- 🟡 Git is called for three lookups (1.5 s each at most); a slow filesystem delays the banner.
- 🔴 No animation, no choice of mascot, no light-theme palette.
