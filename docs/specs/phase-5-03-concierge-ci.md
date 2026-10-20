# Phase 5, slice 3: concierge tools for CI failures

Status: implemented · Branch: `feat/concierge-ci` · Spec: §6.7.3, §7.3 · ADR: 0071

The concierge sees the pull requests whose checks failed and, when the operator confirms, starts `ci-fix` on one or dismisses it.

## Behavior

- `list_ci_failures` (read, untrusted output): the CI watcher's failures (ADR 0041), `open` by default or `started`, `dismissed`, `resolved`. Each row has the failure id, `owner/repo#N`, title, author, failed checks with their conclusion, status, the run once started and the resolve reason. At most 50 rows.
- `fix_ci` (act): `failure_id`, optional `budget`. The proposal's summary names the pull request and the failed checks. After the yes it calls `CiWatcher.fix`, the path of `POST /api/v1/ci/failures/:id/fix`, as the operator: the failure must be open (else the error is shown), and the run is `ci-fix` on the pull request.
- `dismiss_ci` (act): `failure_id`, calls `CiWatcher.dismiss`.
- A paired phone's conversation gets `list_ci_failures` only. The REST routes for fixing and dismissing are desktop only (ADR 0041), so the concierge does not widen what a phone can do (ADR 0063).
- The tools exist when the daemon has a CI watcher; titles and check names reach the model as untrusted text.

## Acceptance

- The list returns open failures, filters by status and rejects an unknown status.
- `fix_ci` and `dismiss_ci` are act tools: nothing happens before the operator confirms, and the actor is the operator.
- A phone's conversation has the list and neither act tool.

## Not in this slice

- Starting `ci-fix` from the Web UI's chat, webhooks beyond the nudge of ADR 0068.
