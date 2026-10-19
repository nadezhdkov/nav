# 0064 — Scheduled runs

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0059 (morning summary), ADR 0041 (CI failure trigger, daily cap), ADR 0039 (Away mode), spec §7.4, UC-14

## Context

Spec §16 lists "scheduled runs" for Phase 4. The nightly triage and the morning summary already run on a clock; what was missing is a run of the user's own choosing started on a timetable.

## Decision

1. **A schedule is the user's setting, kept as events** (`schedule.saved|removed`, projection `schedules`), not a file an agent could edit. It holds a prompt, a registered project, a Flow that starts from a prompt (default `task`; not Compete, which is parked), days of the week, a local time and a **required budget**.
2. **Who sets it.** Policy `schedule.set` allows the user from the desktop or the CLI; paired phones, agents and the daemon are denied. Phones may read the list.
3. **The daemon starts the run** through the same `startRun` as every run, as `{ kind: "system", component: "schedule" }`, so autonomy levels, approvals, budgets and quotas apply unchanged. Policy `schedule.run` lets it do so within `schedules.daily_runs` (5) a day.
4. **Slots.** Every 30 s the daemon looks at each enabled schedule's latest slot not after now. A slot is looked at once (`schedule.fired` or `schedule.skipped` records it); a slot older than the time the user last saved the schedule is ignored, so editing or resuming never starts a stale one; a slot more than `schedules.grace_minutes` (30) old is skipped as `missed`, never started late. There is no backlog.
5. **No stacking.** While the previous run of the schedule has not finished, the next slot is skipped (`still_running`). A failed start is recorded (`failed`) and the schedule goes on.
6. **Surfaces.** `GET /api/v1/schedules` (devices may read it), `POST|PUT|DELETE` for the desktop, `navarch schedule`, and `/schedules` in the Web UI (desktop).
7. **Testing.** `EventStore` takes an optional clock for event timestamps, so time-based services are tested without waiting.

## Consequences

- 🟡 The computer must be on: a slot missed while it was off is not made up.
- 🟡 Daylight-saving changes use the local clock as the OS reports it; a slot that does not exist on a shifted day is not started.
- 🟡 No push notification for a scheduled start or skip yet; the runs notify as usual.
- 🔴 No concierge tool for schedules, and no "run now" button.
