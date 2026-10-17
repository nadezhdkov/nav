# Phase 2, slice 9: CI failure trigger

Status: implemented · Branch: `feat/ci-fix-trigger` · Spec: §6.7.3, §7.3 · ADR: 0041

Navarch notices failing checks on open pull requests by polling, tells the user, and starts `ci-fix` on request. With `ci_fix.auto` it starts the run itself, within a daily limit.

## Behavior

### Watching

- The CI watcher runs with the Inbox's poll (`inbox.poll_minutes`, `navarch sync`). For each project it lists the open pull requests (`GET /repos/:repo/pulls?state=open`) and, for each one that is eligible, the check runs of its head.
- A pull request is **eligible** when its head repository is the project's repository (not a fork), its head branch is not a Navarch `ci-fix` branch (`navarch/*/ci-fix`), and it was not already reported for this head commit.
- A head is **failing** when no check run is still queued or in progress and at least one concluded `failure` or `timed_out`.
- A failing head records `ci.failure.detected` `{ failure_id, project_id, repo, number, title, author, head_ref, head_sha, checks: [{ name, conclusion, url }] }`, once per head commit. Logs are not read here; `ci-fix` reads them when it runs.
- An open failure becomes `ci.failure.resolved` `{ failure_id, reason }` when its pull request closes (`closed`), its head moves (`moved`), or its checks later pass (`passed`).
- Rate limits (403/429) end the poll; the rest waits for the next one. A project that cannot be read is skipped.

### The failure

- Projection `ci_failures`, one row per `failure_id`, status `open`, `started`, `dismissed` or `resolved`.
- `GET /api/v1/ci/failures[?status=]` lists them (default `open`); paired devices may read it.
- `POST /api/v1/ci/failures/:id/fix` starts a `ci-fix` run on the pull request (optional `budget`), records `ci.failure.started` `{ failure_id, run_id }` and answers the run. Only the desktop; `409` unless the failure is open, `400` when GitHub no longer shows failing checks.
- `POST /api/v1/ci/failures/:id/dismiss` records `ci.failure.dismissed`.
- CLI: `navarch ci [--all]`, `navarch ci fix <id> [--budget <usd>]`, `navarch ci dismiss <id>`.

### Automatic start

- `ci_fix: { auto: false, daily_runs: 3 }` in the config. When `auto` is on, each new failure is started by the daemon through the same path, if the Policy Engine allows `ci.auto_fix` (daemon actor, fewer than `daily_runs` automatic starts today in the PC's local time). A denied or failed start leaves the failure open and notifies the user.

### Notifications

- A new failure sends a push, "CI failed on #N" (a notice `ci_failure`, deep link `/home`), in the device's locale. An automatic start sends the run's usual notices.

## Acceptance

- A failing head is reported once; a second poll adds nothing; a new commit with failing checks is a new failure and resolves the old one.
- Fork PRs, `navarch/*/ci-fix` PRs, drafts' pending checks and heads with checks still running are not reported.
- `fix` starts a `ci-fix` run and marks the failure `started`; `dismiss` marks it `dismissed`.
- With `auto` on, the run starts by itself up to `daily_runs`; with it off nothing starts.

## Not in this slice

- Web UI (Home alert and buttons) and the concierge's `list_ci_failures` / `fix_ci`.
- Webhooks (they need the relay).
