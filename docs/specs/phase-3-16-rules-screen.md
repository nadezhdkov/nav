# Phase 3, slice 16: Rules screen

Status: implemented · Branch: `feat/phase-3-16-proposals-ui` · Spec: §6.8.3 · ADR: 0057

Shows each project's rules and the proposals agents made, and lets the user accept or dismiss them in the Web UI.

## Behavior

- `/rules` on desktop: one section per registered project with pending proposals first (text, reason as plain text, proposing run, time, Accept and Dismiss), a note that nothing applies until accepted, then the project's rules with their source (yours or `.navarch/principles.md`).
- The "Rules" tab shows the number of pending proposals; it refreshes on `principle.*` and `project.*` events.
- On a paired phone the buttons are hidden. A refused decision shows the daemon's message.
- Texts exist in English, pt-BR, Spanish, German and Simplified Chinese.

## Acceptance

- The view lists rules and proposals, shows the reason without interpreting markup, accepts and dismisses through the API and reloads, keeps a refusal visible, and refetches only on rule events (`apps/web/test/rules-view.test.ts`).

## Not in this slice

- Adding or removing the user's rules in the UI, a concierge tool, notifications.
