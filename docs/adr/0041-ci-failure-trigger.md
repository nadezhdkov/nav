# 0041 — CI failure trigger by polling

- Status: accepted
- Date: 2026-10-17
- Builds on: ADR 0021 (projects and polling), ADR 0032 (`ci-fix`), ADR 0037 (PR watcher)

## Context

`ci-fix` (ADR 0032) starts only when the user names a pull request. Spec §7.3 begins with "a `check_run` fails on an open PR", and §6.7.3 says events arrive by webhook when there is a public URL (through the relay) and by incremental polling when there is not. Navarch is local-first and has no relay yet, so webhooks cannot reach the daemon.

## Decision

1. **Polling, not webhooks.** A CI watcher reads, for each registered project and on the Inbox's schedule (`inbox.poll_minutes`, and on `navarch sync`), the open pull requests and the check runs of their heads. Webhooks stay for when the relay exists.
2. **A failure is recorded, not acted on.** For an open pull request of the same repository whose head has finished all its check runs with at least one `failure` or `timed_out`, the watcher records `ci.failure.detected` once per head commit. It is a task of the user's attention: they see it and start `ci-fix` or dismiss it. A pull request whose head moved, closed, or whose checks pass later gets `ci.failure.resolved`.
3. **Starting is the existing run.** Fixing a failure starts a normal `ci-fix` run on that pull request (`CreateRunRequest.pull_request`), with the run's usual autonomy, approvals and budgets. Nothing new can write to GitHub.
4. **Automatic start is opt-in.** `ci_fix.auto` (default `false`) lets the daemon start the run itself, at most `ci_fix.daily_runs` (default 3) a day, decided by the Policy Engine (`ci.auto_fix`, daemon only). It never applies to pull requests whose branch is Navarch's own `ci-fix` branch, so a fix that fails CI does not start another fix.
5. **Skipped on purpose.** Pull requests from forks (their code must not run on a trigger nobody asked for), drafts of other repositories, and commit statuses that are not check runs.

## Consequences

- 🔴 Polling delays detection by up to `inbox.poll_minutes`.
- 🔴 A check that never finishes keeps its head from being reported.
- Costs two GitHub reads per open pull request per poll; the listing is one request per project.
