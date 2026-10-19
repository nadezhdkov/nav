# Phase 4, slice 2: opt-in auto-merge

Status: implemented · Branch: `feat/auto-merge` · Spec: §11.1 · ADR: 0060

## Behavior

- `navarch automerge [status]` shows the conditions and each project's state; `on <project> --confirm <owner/repo>` and `off <project>` change it. API: `GET /api/v1/auto-merge` (devices may read it), `PUT /api/v1/projects/:id/auto-merge` (desktop and CLI only; Policy action `automerge.set`).
- Events: `github.auto_merge.enabled`, `github.auto_merge.disabled`, `github.pr.merged`. The kill switch turns it off everywhere.
- `AutoMerger` merges a Navarch PR only when every condition in ADR 0060 holds, through `GitHubIntegration.autoMerge`, after the Policy Engine allows `github.pr.merge` for the `automerge` actor.
- The `reviewer` ends with `navarch-outputs` `{ verdict, blocking, red }`.

## Acceptance

- Policy: only the user (not a phone, agent or system) changes the setting; the merge is allowed only for the auto-merger, enabled, at level 3+ (`apps/daemon/test/automerge.test.ts`).
- Turning on needs the repository name typed back and level 3+, and records the actor.
- A PR meeting every condition is merged once and `github.pr.merged` is recorded; each failing condition (review, counts, verification, autonomy, pushed commit, GitHub facts) keeps it waiting with a reason.
- The kill switch disables it.

## Not in this slice

- A Web UI toggle, WebAuthn re-authentication, legacy commit statuses, PRs of other flows' special cases.
