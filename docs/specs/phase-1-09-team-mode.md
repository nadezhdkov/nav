# Phase 1, slice 9: Team mode (a lead agent and its members)

Status: draft · Branch: `feat/team-mode` · Spec: §4, §6.3, §8.3, §8.4, §9.4, §19 idea 14 · ADR: 0022

A run whose work is led by one agent. The **lead** reads the goal, writes a team plan, hands each part to a **member** (an agent on any adapter, chosen by the Model Router with the lead's preference first), reads their results and the checks, and decides the next turn, until it says the work is done. The user talks to the lead. The Fleet tree that shows this is slice 10.

## Behavior

### Starting a team run

- `navarch run --flow team [--adapter <lead adapter>] [--model <lead model>] <prompt>` and `navarch run --issue <owner/repo#N> --flow team`. Web UI New run and the Inbox's "Start run" offer the `team` Flow. The concierge's `start_run` accepts `flow: team`.
- Without `--adapter`/`--model`, the lead is routed with profile `lead`, tier `expert` (Claude Code first by default, ADR 0013).

### The `team` Flow (`flows/team.yaml`)

```
start → team → review → open_pr
```

- `team` is a new node type: `{ id, type: team, lead: { profile: lead }, max_turns, approve_first_plan }`.
- `review` reads the lead's final summary; `open_pr` runs only for issue runs (`when: ${{ run.work_item }}`), as a draft, and below autonomy level 3 waits for approval as today. A prompt run ends after review, like `task`.

### Inside a `team` node, turn by turn

1. **Lead turn** (task `team.lead`, iteration = turn). The prompt carries the goal (prompt or delimited issue), the team so far (each member: key, title, profile, adapter/model, status, summary), the latest verification result, the user's instructions (ADR 0019), turns and budget left, the catalog entries it may prefer, and on turns after the first, the reason for this turn. A resumable adapter resumes its session; others get the same context in full.
2. The turn must end with a fenced block:
   ````
   ```navarch-team
   { "summary": "…", "done": false, "question": null,
     "members": [ { "key": "api", "title": "…", "brief": "…", "profile": "implementer",
                    "prefer": "codex", "depends_on": [] } ] }
   ```
   ````
   - `members` adds members (keys are new, `[a-z0-9-]{1,32}`); `depends_on` names earlier or same-turn keys; `profile` ∈ `planner | researcher | implementer | reviewer`; `prefer` is an adapter id or a catalog entry id, optional.
   - A missing or invalid block fails the turn's output check: the next turn starts with the validation error. Two invalid turns in a row fail the node.
3. **First-plan approval**: when `approve_first_plan` is true (autonomy < 3), the first plan with members waits for a human (approval subject `team.plan`, showing summary and members). Rejecting fails the run, as with `approve_plan`.
4. **Members** run one at a time in `depends_on` order (ties by plan order), in the run's worktree (task `team.<key>`). Their prompt is the profile's rules, the lead's brief, and the summaries of the members they depend on. Each is routed (profile tier, the lead's `prefer` tried first when available) and retried like any task. A failed member does not fail the node: the lead sees it next turn.
5. **Verify** (task `team.verify`, iteration = turn) runs the project's checks once all of the turn's members finished, when any member edits.
6. **Next turn** starts with what happened. The node **succeeds** when a turn says `done: true` and the latest verification passed (or nothing was edited). `done: true` with failing checks starts another turn with "checks still fail". The node **fails** at `max_turns` (Flow param, default 8) or when the run budget is exhausted (budget stop, as today).
7. **Questions**: a turn with `question` set (and no members) stops the team: the next lead turn is created `blocked` with reason `question`, the question is shown to the user (Fleet, run detail, push notification "agent waiting for you"), and the first instruction sent to the run unblocks it.

### Context and tokens

Navarch does not manage a CLI agent's internal context (each has its own harness); it manages what goes into each prompt.

- **Isolation**: a member's prompt holds its profile's rules, the lead's brief and the summaries of the members it depends on. It never gets the lead's conversation or the other members' work.
- **Bounded summaries**: in the lead's prompt each member's summary is capped (2,000 characters, cut with a marker); the full output stays in the member's task and artifacts.
- **Informed preferences**: the lead's prompt lists the enabled agents (catalog entries) with what is known of their quota (exhausted until when, last observed utilization and reset), so `prefer` picks agents that can run now.

### Instructions and chat

- An instruction to a team run without `task_id` goes to the next lead turn. `now` on a running lead interrupts and resumes it (ADR 0019). Instructions to a member stay possible with `task_id`.
- The lead's turn summaries and questions are the lead's side of the chat (slice 10 shows them as a conversation).

### Internal sub-agents

- When the lead runs on Claude Code and uses its own `Task` tool, each call is recorded as `task.subagent { tool_use_id, description, status: started | finished }`, from the stream. They are part of the lead's task: no routing, grant or budget of their own.

## Policy

- `team.turn` before each lead turn and `team.delegate` before each member: denied when the run is paused or stopped, when `max_turns` or `max_members` would be exceeded, or when the run's spent cost is at or over its budget. A denial fails the node with the reason.
- Grants: the `lead` profile edits (it may fix small things itself), with the project allowlist like the implementer. Members get their own profile's grant. Neither the lead nor members can change autonomy, grants, budgets or auto-merge; the team plan has no field for it.
- The issue body is still untrusted input to every turn; briefs written by the lead are the lead's output and go into members' prompts inside an `<input name="brief">` block.

## Contracts (contracts first, `packages/contracts`)

- Flow: `TeamNode` in `FlowNode`; `team` leaves nothing in `PHASE_2_NODE_TYPES`.
- `TeamPlan`, `TeamMemberSpec` (the block above); `TeamMemberProfile`.
- Events: no new team events. The team plan is the lead turn's own output (`task.completed`), parsed by the Flow engine; the team's tasks carry `team: { node_id, role: lead | member | verify | approval, key? }` in `task.created`. New: `task.subagent { tool_use_id, description, status }`.
- `RunDetail.team: { node_id, turn, max_turns, members: TeamMemberView[], question: string | null } | null`, with `TeamMemberView { key, title, profile, prefer, depends_on, added_in_turn, task_id }`. `FleetAgent` gains `team_role: "lead" | "member" | null` and `team_key`.
- Limits are the `team` Flow's params `max_turns` (8) and `max_members` (12). Routing profiles `lead` (tier `expert`) and `researcher` (tier `fast`).

## Tests (no network, no real agent)

- Contracts: `TeamPlan` accepts the documented shape, rejects unknown profiles, bad keys, unknown or cyclic `depends_on`.
- Flow engine (pure): first turn; members in dependency order; verify after an editing turn; next turn; done with passing checks; done with failing checks; max turns; invalid block then valid; two invalid blocks; question → blocked → unblocked by a message; approval of the first plan below level 3; restart mid-team derives the same next step.
- Orchestrator with fake agents: a fake lead (fake Claude scenario `lead`) that delegates to a member routed to the fake Codex, reads its summary, and finishes; `prefer` honoured when available and skipped when its quota is exhausted; member failure reaches the lead; policy denials for turn and member limits and budget; instruction to the run reaches the next lead turn.
- Claude stream: `Task` tool_use and its result produce `task.subagent` events.
- CLI `--flow team`, concierge `start_run` with `flow: team`.

## 🔴 Open

- Members in parallel, each in its own worktree, with an `integrate` node (Phase 2, ADR 0022 §4).
- A lead that spawns a whole sub-team (members that lead): Phase 2 `subflow`.
- The Fleet tree and lead chat UI: slice 10.
- Daily and per-project budgets before leaving team runs unattended: budgets slice.
- Auto-merge: separate opt-in work, by the human only (merge policy in `AGENTS.md`).
