# Phase 4, slice 1: morning summary

Status: implemented · Branch: `feat/morning-summary` · Spec: §7.4, §16 Phase 4 · ADR: 0059

## Behavior

- `summary` config: `enabled` (false), `at` (`HH:MM`, local, `08:00`), `stalled_days` (3).
- Once a day, after `at`, the daemon syncs every project, open PRs and CI failures, builds the summary and records `summary.generated`. The Notifier pushes "Morning summary" with counts to `/home`.
- `MorningSummary` (`packages/contracts/src/summary.ts`): new items, duplicates, CI failures, stalled PRs, approvals waiting, runs finished and failed, billed cost, suggested runs with their estimate.
- `GET /api/v1/summary` (latest or null; devices may read it), `POST /api/v1/summary` (makes one now; desktop only), `navarch summary [--now]`.

- Home has a Summary card (all five locales) with a "Make one now" button on the desktop only.

## Acceptance

- Items, duplicates, suggestions and the estimate are computed from the Inbox view (`apps/daemon/test/summary.test.ts`).
- One summary a day, not before `at`, with a refresh first; the next one starts from the previous `generated_at`.
- The notice is `summary` with the translated title and counts only.

## Not in this slice

- Filters by project, weekday schedules, delivery by e-mail.
