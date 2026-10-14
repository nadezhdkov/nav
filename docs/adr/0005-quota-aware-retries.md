# 0005 — Quota-aware retries: wait for the reset, pause when it is far away

- Status: accepted
- Date: 2026-10-14
- Spec: §6.1.2 (Scheduler), §8.3/§8.4 (state machines, no new states), §10 (`/runs/:id/resume`)

## Context

Agents on subscription plans (Claude Code, Codex, Antigravity) and free API tiers (Gemini) run out of quota in the middle of a task. Phase 0 retried a `rate_limited` task immediately, up to `max_attempts`, so an exhausted daily or weekly quota failed the run within seconds, although the worktree and the agent's conversation were still there to continue.

Most agents say when their quota comes back:

| Agent | Where the reset time comes from |
|---|---|
| `claude-code` | `rate_limit_event` in `stream-json`, every run: status, refused window, utilization and `resetsAt` for the 5-hour and weekly windows |
| `codex` | not in `exec --json`; the session file `$CODEX_HOME/sessions/…/rollout-…-<thread>.jsonl` has `rate_limits.primary/secondary` with `used_percent`, `window_minutes`, `resets_at` |
| `gemini-cli`, `antigravity` | only in the error text (`Please retry in 23s`, `"retryDelay": "23s"`, `Refreshes in 167h 2m`) |
| `native` | the `Retry-After` header of a 429 |

## Decision

- **Contracts:** `TaskError.retry_at` (ISO 8601) on rate-limited results; adapter event `quota` and store event `quota.observed` (`adapter`, `window`, `utilization`, `resets_at`, `exhausted`); `task.status_changed.not_before` on `failed → ready`; `TaskView.not_before`.
- **Adapters:** Claude Code and Codex publish `quota.observed` on every run and take `retry_at` from the refused window. Other CLIs get `retry_at` from `retryAtFromText` in the adapter kit, applied in `cliOutcome`. Claude's "You've hit your limit" and a `rejected` limit event are classified `rate_limited`.
- **Scheduler:** a `rate_limited` task goes back to `ready` with `not_before` = reset + 5 s, or the next step of `scheduler.rate_limit_backoff_minutes` (default 1, 5, 15, 60) when the agent gave no time. A timer wakes the scheduler when the first waiting task is due, and the wait survives a daemon restart because it is in the event log. These waits do not count toward `max_attempts`.
- **Pause instead of fail:** when the reset is more than `scheduler.rate_limit_max_wait_hours` away (default 12) or the task has waited `rate_limit_max_waits` times (default 8), the run moves to `paused`, the existing side exit of §8.4, with the reset time in the reason. `POST /api/v1/runs/:id/resume` (CLI `vectr run resume <id>`) requeues the failed tasks; they keep their resume token, so the agent continues the same conversation.
- **Projection migration:** projections are derived data. When the `tasks` table lacks a new column, the store rebuilds the projections from the log on open.

## Consequences

- An exhausted 5-hour window costs a wait, not a failed run. A weekly limit pauses the run with the date it can continue.
- Real runs on 2026-10-14 recorded the user's Claude windows (5-hour 58%, weekly 93%, with reset times) and Codex's free plan window (30 days, 0%).
- Antigravity and Gemini reset times depend on the wording of their error messages, which was not observed in a real quota error yet; without a match the backoff applies.
- `quota.observed` is in the log only. Choosing another agent when one is near its limit, and a quota overview command, belong to the Model Router in Phase 1.
