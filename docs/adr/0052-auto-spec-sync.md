# 0052 — Starting `spec-sync` on its own after a merge

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0049 (`spec-sync`), ADR 0037 (PR watcher), ADR 0041 (the `ci_fix.auto` pattern)

## Context

`spec-sync` (ADR 0049) writes an addendum for a merged pull request, but only when the user starts it. The PR watcher already sees every pull request Navarch opened close, and `ci_fix.auto` already shows how the daemon may start a run by itself under a daily cap.

## Decision

1. **Opt-in, off by default:** `spec_sync.auto` (`false`) and `spec_sync.daily_runs` (3, local day), next to `ci_fix`.
2. **Trigger:** the PR watcher calls `onMerged` after it records `github.pr.closed` with `merged: true`. `SpecSyncTrigger` (`apps/daemon/src/github/specsync.ts`) starts `spec-sync` on that pull request with `startRun`. A failure in the hook never stops the watcher.
3. **Only where it makes sense:** the repository must be a registered project that already keeps specs with Navarch (a run in its clone wrote `spec.generated` or `spec.addendum.written`), and the merged pull request must not come from a `reverse-spec` or `spec-sync` run, since syncing on a pull request that only adds specs would never end.
4. **Once per pull request, within the cap:** `spec.sync.auto_started` records `{ repo, number, project_id, run_id }` and is both the dedup key and the daily count. The Policy action `spec.auto_sync` (system actor only) allows it under `daily_runs` and denies it otherwise.
5. **Nothing else is automatic:** the run is an ordinary `spec-sync` run. Its draft PR (`pr.specs`) still waits for approval below autonomy level 3, and Away mode never delegates it (ADR 0048). Budgets apply as for any run.

## Consequences

- 🟡 Only pull requests Navarch opened are seen; merges of other people's pull requests do not trigger it (a merged-PR listing would be needed).
- 🟡 A run that fails to start (for example GitHub not answering) leaves no record and is not retried; the user can still start `spec-sync` by hand.
- 🟡 A project's specs must already have gone through Navarch for the trigger to fire; specs written by hand count only after one `spec-sync` or `reverse-spec` run there.
- 🔴 The auto-started runs are not marked in the UI yet (the event and `run_id` are in the log).
