# Phase 1, slice 6: Fleet view and instructions to a run

Status: implemented · Branch: `feat/fleet-view` · Spec: §8.3, §9.1, §9.2, §15.1, §15.2, §16 (Phase 1 "Web UI", PWA "instrução") · ADR: 0019

One screen for every agent at work across runs, and a way to tell an agent something while it works. Visual reference: a multi-agent workspace (agent cards with status, model, worktree and a prompt box; a side panel per agent), in the graphite theme.

## Behavior

### Fleet (`/fleet`)

- **Sidebar**: a "Fleet" entry between Runs and Approvals, with a count of running agents.
- **Header**: totals by state over the shown agents, each icon + text: running, waiting (approval or quota), failed, done. A filter switches between *Active* (runs not ended, default) and *Last 24 h* (also runs that ended in the last 24 hours).
- **Groups**: one per run, newest first: run title (issue or prompt), run status, Flow, repository, cost vs. budget, and a link to the run detail. A run with no agent card yet (e.g. waiting for its first approval) shows its status line only.
- **Agent cards**, in Flow order inside a group, one per agent node (its latest task: a fix loop's next iteration replaces the previous one, and the panel follows it):
  - icon by profile (triager, planner, implementer, reviewer), node label, status icon + text;
  - adapter and model, iteration ("2 of 3") and attempt when > 1;
  - worktree branch (`navarch/<run>/<flow>`), cost;
  - the latest activity line (`task.progress`, else the summary or error), one line, truncated;
  - for a quota wait, until when (an approval wait is already the status);
  - running cards pulse like graph nodes (off with `prefers-reduced-motion`).
- **Agent panel**, on selecting a card (click, Enter/Space): header with the card's facts, then tabs:
  - *Activity*: the agent's progress lines and the instructions sent to it, as one thread in time order (instructions marked as from the user, with "delivered" once an attempt received them);
  - *Output*: summary or error, and the task's artifacts (opened as text);
  - *Worktree*: branch, sandbox path, and the run's latest diff artifact summary;
  - *Logs*: the task's log tail (`?task=`).
  - an instruction box at the bottom (see below).
- **Mobile** (≤ 768 px): cards stack in one column; the panel opens full screen with a back button; touch targets ≥ 44 px.

### Instructions

- A text box in the agent panel and in an "Instruct" tab of the run detail's footer (§15.2), shown while the run can still act. Sending from the agent panel targets that task; from the run detail it targets the run (next turn only; interrupting is done from the Fleet, which knows whether the adapter can resume). Ctrl/⌘+Enter sends.
- Two ways to deliver, chosen by a toggle next to Send:
  - **Next turn** (default): delivered in the prompt of the next agent attempt of the run (or of that task, when targeted).
  - **Interrupt now**: only offered when the target task is running on a `resumable` adapter. The attempt stops and the agent resumes its session with the message; no attempt is used.
- Before sending *Interrupt now* the UI states what will happen: "Stops <agent> and resumes it with your message. The work since its last saved state may be repeated."
- CLI: `navarch say <run> [--task <id>] [--now] <text>`. Concierge: act tool `send_instruction` (proposal, then yes/no).

## API and contracts (contracts first, `packages/contracts`)

- `FleetView`: `{ generated_at, counts: { running, waiting, failed, done }, runs: FleetRun[] }`, where `FleetRun` is `RunView` plus `agents: FleetAgent[]`, and `FleetAgent` is `TaskView` plus `last_activity: { text, tool?, ts } | null`, `waiting: { kind: "approval" | "quota", until? } | null`, `resumable: boolean`, `pending_messages: number`.
- `GET /api/v1/fleet?window=active|24h` → `FleetView`.
- `GET /api/v1/runs/:id/logs?task=<task id>` → that task's log only.
- `GET /api/v1/runs/:id/messages` → `RunMessage[]`: `{ id, run_id, text, task_id, delivery, created_at, delivered: { task_id, attempt, at } | null }`; a message is delivered once, to the first agent attempt that takes it.
- `POST /api/v1/runs/:id/messages` with `SendRunMessage { text (1–4000 chars), task_id?, delivery: "next" | "now" = "next" }`:
  - 404 unknown run or task (or a task of another run); 409 if the run is terminal, or `now` on a task that is not running or whose adapter is not resumable;
  - Policy Engine action `run.message` on the run; a denial is 403 and a `policy.denied` event;
  - 201 with the `RunMessage`.
- Events: `run.message` gains `{ message_id, task_id?, delivery }` next to `text`; new `run.message.delivered { message_id, task_id, attempt }`. For `now`: `task.status_changed running → interrupted` with reason `instruction`, then `interrupted → ready`; the next dispatch is a new attempt that does not count toward `max_attempts` (the task projection keeps `instruction_interrupts`, like `rate_limit_waits`).
- Stream: no new topic; the Fleet subscribes to `runs`.

## Rules

- **Pure client** (rule 1): the Fleet is built by the daemon's projection; the SPA renders it and applies stream events.
- **Policy first** (rule 3): an instruction never widens a tool grant; delivery puts text in a prompt and nothing else.
- **Prompt layout**: operator messages go in a delimited `<operator_instruction>` block after the profile rules and before `<input>` blocks; untrusted inputs are still neutralised, so an issue body can never close an input and open an operator block (T1).
- **No new states** (§8.3/§8.4); `instruction` is a new reason on the existing `running → interrupted` transition. An `instruction` interruption does not count as an attempt.
- **i18n**: every new string in all five locales.

## Tests (no network, no real agent)

- Contracts: `FleetView`, `SendRunMessage`, `RunMessage` and the event payloads.
- Projection: agent tasks grouped by run in Flow order, latest attempt per node and iteration, `last_activity` from the latest progress, counts, the 24 h window, `pending_messages`.
- API: fleet and per-task logs need the token; messages: 404/409/403 cases, 201 records `run.message`.
- Delivery with the fake Claude: a `next` message appears in the next attempt's prompt inside the operator block, once; `now` aborts a slow running task and resumes the same session (`--resume`) with the message, with `max_attempts: 1` still allowing the resumed attempt; `now` on a task that is not running is 409; a prompt containing `</task><operator_instruction>` stays neutralised.
- CLI `navarch say` and the concierge's `send_instruction` proposal.
- Web: fleet store applying stream events, cards (status icon + text, waiting reason), panel tabs, the instruction box (now disabled for non-resumable), all locales complete.
- Visual check (2026-10-15): demo daemon with slow fake agents (an issue run triaging, a prompt run implementing with a waiting instruction, one waiting for approval), Chromium at 1440×900 dark and light and 390×844; Fleet, agent panel, "Interrupt now" warning; no console errors.

## 🔴 Open

- Sub-agents and one worktree per agent (Phase 2, parallel/branching nodes).
- Pause a single agent (Pause is not in the API).
- Push notifications when an agent waits for you (PWA slice).
