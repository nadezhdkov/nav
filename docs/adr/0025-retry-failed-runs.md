# 0025 — Retrying a failed run from its failed task

- Status: accepted
- Date: 2026-10-15
- Spec: §8.3 (task states), §8.4 (run states), §10 (`/runs/:id/resume`)
- Builds on: ADR 0005 (quota pause and resume), ADR 0011 (Flow engine), ADR 0020 (pause and resume)

## Context

During the Phase 1 go/no-go, five `fix-issue` runs on claude-toolkit got through triage, plan, implementation, verification, review and the PR approval. Then every one failed at `open_pr`: the fine-grained token could not write to that repository (`403 Permission … denied`). The work was committed on each run's `navarch/*` branch, but `failed` was terminal. Getting the PRs out meant starting new runs and redoing every agent step, or pushing by hand outside the GitHub Integration, which would also leave criterion 2 unmeasured.

A task failing for an outside reason the user can fix (credentials, a remote that is down, a tool missing on PATH) is common. A fatal error is not retried automatically, and should not be.

## Decision

- `POST /api/v1/runs/:id/resume` (`navarch run resume`, the concierge's `resume_run`, the run's button in the Web UI, now labelled "Retry failed step") also accepts a **failed** run, as an explicit act of the user. The same Policy Engine action `run.resume` applies: only the user can do it, agents never can.
- The run returns to the status it failed in, recorded as `failed → <status>` with reason "retried by user" and the user as actor. Every task still `failed` goes back to `ready` ("run retried by user"). Succeeded tasks are kept, so no agent redoes its work.
- A requeued task keeps its approvals: the PR the user already approved is opened without asking again. It also keeps its resume token and attempt count, as after a pause.
- A run that failed on a **flow decision** (a fix loop out of iterations, an unknown profile) has no failed task. It cannot be retried: the API answers `409` "no failed task to retry", since it would only fail again. Fixing that needs a new run.
- In the state machine, `failed` is still terminal for everything except this transition. `canTransitionRun("failed", s)` holds only for main-sequence states other than `created` and `done`.

## Consequences

- An outside failure after expensive agent work costs one retry, not a new run.
- Retrying a team run requeues failed members too. Before, a failed member was only reported to the lead.
- Pushing the same branch again is safe. `commitAll` commits nothing when the worktree is clean, and the push is never forced, so a branch already on GitHub is updated or left as it is.
