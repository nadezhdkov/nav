# Scheduled runs

A **scheduled run** starts a run for you at set times: a nightly clean-up of flaky tests, a weekly dependency check, a Monday-morning review of what changed. You write the prompt once, pick the days and the time, and give it a budget.

```sh
navarch schedule add nightly-flaky "Find tests that fail intermittently and fix the worst one" \
  --at 03:00 --days weekdays --budget 2
navarch schedule              # each schedule, its next slot and what the last one did
navarch schedule pause <id>   # or resume, or remove
```

In the Web UI, **Schedules** (desktop) does the same with a form.

## How it behaves

- Times are the **local time of the computer** that runs Navarch.
- Every schedule needs a **budget**. Nobody is watching when it starts, so the run stops at that limit.
- The run goes through the usual rules: autonomy levels, approvals, budgets and quotas. Below autonomy level 3 it waits for you to approve the plan and the PR, as any run does.
- A schedule starts runs from a **prompt** in a registered project. Flows that need an issue or a pull request cannot be scheduled.
- If the previous run of the same schedule is still going, the next slot is **skipped**, not stacked.
- If the daemon was off at the time, the slot is **skipped** when more than `schedules.grace_minutes` (30) have passed. Navarch never starts a backlog when it wakes up.
- The daemon starts at most `schedules.daily_runs` (5) a day, across all schedules.
- Only you set schedules: not a paired phone, not an agent. A phone can read them.

Every start and every skip is recorded with its reason, and shown in the list.
