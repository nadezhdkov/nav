# Phase 4, slice 6 — scheduled runs

Status: implemented. ADR 0064. Spec §7.4, UC-14.

## Behaviour

- `navarch schedule add <name> <prompt> --at HH:MM [--days …] --budget <usd> [--flow]`, `list`, `pause|resume|remove`; `/schedules` in the Web UI.
- At each slot (local time) the daemon starts a run in the project with the schedule's prompt, Flow and budget. Missed slots, running predecessors, the daily cap and failures are recorded as `schedule.skipped`.
- Only the user sets schedules; a phone reads them.

## Acceptance

- A slot starts once; a missed one never starts late; resuming or editing never starts a past slot.
- A phone, an agent and the daemon cannot save a schedule.
- Flows that need an issue or a pull request, and Compete, are refused.
