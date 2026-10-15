# 0019 — Fleet view and instructions to a run

- Status: accepted
- Date: 2026-10-15
- Spec: §9.1 (`POST /runs/:id/messages`), §9.2 (`run.message`), §8.3 (`running → interrupted`), §15.1, §15.2 (field to send an instruction to the run), v0.14
- Slice: [`docs/specs/phase-1-06-fleet-view.md`](../specs/phase-1-06-fleet-view.md)

## Context

The run detail (ADR 0017) shows one run at a time. With several runs in flight, the user wants one screen for every agent at work, in the style of a multi-agent workspace: a card per agent with its status, model, worktree and latest activity, a side panel to follow one agent, and a box to tell it something. The spec already plans the second half: §15.2 puts "a field to send an instruction to the run" in the run detail, §9.1 lists `POST /api/v1/runs/:id/messages` and §9.2 the `run.message` event, but none of it is built, and §16 asks for instructions from the phone in Phase 1.

Three questions needed an answer:

1. What the screen is in the domain, and what to call it. The glossary (§4) already uses **Workspace** for "the set of projects one Navarch installation manages", so the screen cannot take that name.
2. How an instruction reaches an agent. The CLIs run headless (`claude -p`, `codex exec`…): there is no channel to type into a running process. What they have is session resume (ADR 0003, ADR 0005), which every adapter except `native` supports.
3. How much of the mockup's hierarchy (a manager agent with sub-agents, each in its own worktree) fits the current model, where a run's agents run in sequence and share one worktree (slice 2).

## Decision

### The Fleet view

- **Fleet** (a navarch commanded a fleet) is a **screen, not a domain concept**: a read model over the existing Runs and Tasks. It adds no entity, no state and no glossary term; §15.1 lists it next to Runs.
- It shows **agent tasks** (tasks with a profile, i.e. Flow nodes of type `agent`) of runs that are not terminal, plus those that ended in the last 24 hours, grouped by run in Flow order. Actions and gates appear only as the run's progress, not as cards.
- The daemon serves it as one projection, `GET /api/v1/fleet`, so the screen does not fetch every run's detail. Live updates use the existing `runs` stream topic, which already carries every run's task events.
- A task's log can be read on its own: `GET /api/v1/runs/:id/logs?task=<task id>` (each task already writes `logs/<run>/<task>.log`).

### Instructions to a run

- `POST /api/v1/runs/:id/messages` with `{ text, task_id?, delivery: "next" | "now" }` records a **`run.message`** event (actor: the user) after the Policy Engine allows action `run.message` on the run. The request never changes tool grants, the allowlist, protected paths, autonomy or budget: an instruction is text for the agent, and what the agent may do is still decided by the policy alone (rule 3).
- **`next`** (default): the message waits and is delivered in the prompt of the next agent task of the run that starts (a new node, a fix iteration or a retry), then marked delivered. If `task_id` names a task, only that task's next attempt receives it.
- **`now`**, only for a task that is `running` on a `resumable` adapter: the Scheduler aborts that attempt and the Orchestrator moves the task `running → interrupted → ready` with reason `instruction`, **without using an attempt**; the next dispatch resumes the agent's session with the message as the new turn. For the `native` adapter (no resume) and for tasks that are not running, `now` is refused with 409 and the UI offers `next`.
- Delivery: messages are rendered in the task prompt inside a delimited **operator instruction** block, after the profile rules and before untrusted inputs. They come from the local user, so they are instructions, not data; the agent's profile still bounds them (a read-only reviewer stays read-only).
- Each delivery is recorded (`run.message.delivered` with the task id), so the Fleet view and the timeline show which agent received which message. No new task or run states: `running → interrupted` gains `instruction` as a reason next to "lease expired / restart".
- The CLI gets the same verb: `navarch say <run> [--task <id>] [--now] <text>`; the concierge gains it as an act tool (`send_instruction`), behind the usual yes/no proposal.

### What stays out

- **Sub-agents and a worktree per agent**: the mockup's tree of agents, each in its own branch, needs parallel and branching Flow nodes and several worktrees per run. That is Phase 2 (§16) and needs its own ADR; this view groups by run instead.
- Creating agents from the Fleet ("Create Agent"): a new agent is a new run (`navarch run`, the concierge), which the view links to.
- Pausing a single agent: Pause is not in the API yet (ADR 0017's open items).

## Consequences

- The run detail gets the same instruction box (§15.2's footer), so both screens share one API.
- Interrupting a running agent costs what the resumed turn costs; the budget gate applies as usual. `now` loses the attempt's in-flight work only up to the agent's last saved session state, which is what the CLIs persist on their own.
- No adapter change: the API checks the existing `AdapterCapabilities.resumable` before accepting `now`.
- Content from the operator joins the prompt, so prompt rendering gets a test that untrusted inputs can never be rendered as an operator block (T1).
