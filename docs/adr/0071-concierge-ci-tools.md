# 0071 — Concierge tools for CI failures

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0016 (concierge), ADR 0041 (CI failure trigger), ADR 0063 (phone chat)

## Context

The CI watcher records failing pull requests and the user fixes them from Home or with `navarch ci`, but the concierge, which already reads runs, the Inbox and usage, could not see them (ADR 0041 left this out).

## Decision

1. One read tool, `list_ci_failures`, and two act tools, `fix_ci` and `dismiss_ci`, bound to `CiWatcher.list|fix|dismiss`, the functions the REST routes call. Act tools follow the concierge's rule: a single-use proposal that runs as the operator after an explicit yes, so the Policy Engine applies as it does for the CLI.
2. A paired phone's conversation gets the read tool only, because the REST routes that fix and dismiss are desktop only. The concierge must not be a way around the device allowlist.
3. The failure's title and check names are untrusted text (`untrusted: true`).

## Consequences

- 🟢 One way to start `ci-fix` from chat, with the same checks (open failure, registered project) as the API.
- 🟡 A phone user must go to the desktop to start the fix; the notification already points to Home.
