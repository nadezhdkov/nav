# Phase 3, slice 11: `spec-sync` after every merge

Status: implemented · Branch: `feat/phase-3-11-auto-spec-sync` · Spec: §6.8.1 · ADR: 0052

With `spec_sync.auto: true` the daemon starts `spec-sync` for each pull request of Navarch's that gets merged.

## Behavior

- Config `spec_sync: { auto: false, daily_runs: 3 }`.
- The PR watcher calls `onMerged` for a merged pull request; `SpecSyncTrigger.merged` starts `spec-sync` (`pull_request: owner/repo#N`) in the project of that repository.
- It skips: `auto` off; a project that keeps no specs with Navarch; a pull request from a `reverse-spec` or `spec-sync` run; one already started; and anything past `daily_runs` (Policy `spec.auto_sync`).
- `spec.sync.auto_started` records each start.

## Acceptance

- A merged pull request in a project with specs starts exactly one run, and a second signal starts none.
- Off by default; no specs, spec-only pull requests and a used-up daily cap start nothing; a failed start records nothing.
- The PR watcher tells `onMerged` about merged pull requests only, and survives a failing hook.

## Not in this slice

- Merges of pull requests Navarch did not open, retrying a failed start, marking auto-started runs in the UI.
