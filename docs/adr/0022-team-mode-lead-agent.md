# 0022 — Team mode: a lead agent that delegates to other agents in turns

- Status: accepted
- Date: 2026-10-15
- Spec: §4 (TaskGraph "can grow dynamically"), §6.3, §6.5.2, §8.3, §8.4, §9.4, §16 (Phase 2 `parallel`/`join`/`subflow`), §19 ideas 14–15
- Slices: [`docs/specs/phase-1-09-team-mode.md`](../specs/phase-1-09-team-mode.md), [`docs/specs/phase-1-10-fleet-tree.md`](../specs/phase-1-10-fleet-tree.md)
- Builds on: ADR 0011 (Flow engine), ADR 0013 (Model Router), ADR 0019 (instructions to a run), ADR 0021 (projects)

## Context

The user wants one agent per run to act as **team lead**: it understands the goal, splits it, hands each part to the agent best suited for it (Claude Code, Codex, Gemini CLI, antigravity, Copilot, OpenCode or `native`), reads their results, decides what comes next, and is the only agent the user talks to. The lead may also use its own internal sub-agents. The Fleet view should show this as a tree: lead → members, with the links between them.

Today a run follows a fixed Flow (`fix-issue`, `task`): a chain of nodes known before the run starts. The spec already allows a TaskGraph to grow at run time (§4) and plans `parallel`, `join` and `subflow` nodes for Phase 2. Nothing lets an agent add work to its own run.

Three ways to let the lead delegate were considered:

1. **Tools over MCP.** The lead calls `delegate`, `wait`, `team_status` while its session stays open. Only some adapters speak MCP; the lead's session would sit idle, holding a process, while members work for minutes or hours; a daemon restart would lose the open call.
2. **The lead as a Flow author.** The lead writes a Flow YAML and the run switches to it. The Flow format has no way to say "then ask me again", which is what a lead does.
3. **Turns.** The lead works in turns. Each turn is an ordinary agent task that ends with a structured **team plan**: what to delegate, to whom, in which order, whether it is done, and what to tell the user. The Orchestrator creates one task per delegation, runs them, and starts the next lead turn, resuming the lead's session, with their results.

## Decision

1. **Turns (option 3).** A new Flow node type, `team`, holds a lead and its members. Its state is derived, like every other node, from the run's tasks: the lead's turns are tasks of node `<team>.lead` (iteration = turn), and each member is a task of node `<team>.<member-key>`. The Flow engine stays pure: given the tasks and their outputs it returns the next step. A restart resumes a team run like any other run, and every adapter can lead (a non-resumable adapter gets the previous turns' plans and results in its prompt instead of a resumed session).
2. **The team plan is validated output.** A lead turn must end with a fenced `navarch-team` JSON block, validated by Zod: `members` (key, title, brief, profile, optional adapter/model preference, `depends_on`), `done`, `summary`, and an optional `question` for the user. An invalid block costs one lead turn, and the next turn gets the validation error.
3. **Members are routed agents.** A member's `profile` is one of the existing profiles (`planner`, `implementer`, `reviewer`) or `researcher` (read-only, new). Its adapter and model come from the Model Router, as in ADR 0013, with the lead's preference tried first when that entry is available. The lead names a preference; it never bypasses routing, quotas or the catalog.
4. **One worktree, one member at a time, in Phase 1.** Members run in `depends_on` order, one after another, in the run's shared worktree. Running members in parallel, each in its own worktree, with an `integrate` node, is Phase 2; the plan format already carries `depends_on` so the same plans run in parallel later.
5. **"Full permission" means autonomy level 3, not a bypass.** The lead and its members act inside the Policy Engine like any task. Each lead turn is a `team.turn` action and each member a `team.delegate` action, checked against the run budget and the `team` Flow limits `max_turns` (default 8) and `max_members` (default 12, over the whole run). At autonomy level 3 no human is asked; below it, the lead's first plan waits for approval like the `fix-issue` plan, and the PR waits as today. The lead cannot change autonomy, tool grants or auto-merge.
6. **The user talks to the lead.** Instructions sent to a team run (ADR 0019) go to the lead's next turn by default. A `question` in a team plan stops the team: the lead's next turn is created `blocked` (reason `question`) and becomes `ready` when the user answers with an instruction. A member can still be addressed directly from the Fleet.
7. **Internal sub-agents are observed, not managed.** When the lead's adapter reports sub-agents of its own (Claude Code's `Task` tool), they are shown under the lead as internal, from its progress stream. Navarch does not route, budget or grant them separately: they are part of the lead's task.

## Consequences

- A new Flow, `team` (lead → team → verify ⇄ fix → review → draft PR), and `navarch run --flow team`. `fix-issue` and `task` keep working unchanged.
- No new team events: the plan is the lead turn's output in `task.completed`, and team tasks say their role in `task.created`, so the team is a projection of the run's tasks. Task and Run states do not change: a question uses the existing `ready → blocked → ready` transitions.
- The Fleet tree (slice 10) draws lead → member edges ("delegates"), member → member edges (`depends_on`) and member → lead edges ("reports").
- Cost grows with every turn. Turn and member limits and the run budget bound it now; the budgets slice adds daily and project budgets before team runs are left unattended.
- `parallel` and `integrate` stay in Phase 2, as the spec plans. This ADR moves only the `team` node and the lead profile into Phase 1, by the user's choice on 2026-10-15.
