# 0011 — Flow engine v1: linear YAML flows, tasks created as nodes become due

- Status: accepted
- Date: 2026-10-14
- Spec: §6.2 (node types and properties), §7.1 (issue → PR), §8.3–8.4 (state machines), §9.4 (Flow format), §11 (autonomy levels), §16 Phase 1
- Supersedes: the fixed `implement → verify → open_pr` chain of slice 1

## Context

Slice 1 ran every run as a chain hardcoded in the Orchestrator and Scheduler. Phase 1 requires the `fix-issue` Flow in YAML (triage, plan, approval, implementation, verification, review, PR), and the issue-to-PR sequence in §7.1 needs a fix loop, so a run must be able to add tasks after it starts. The visual editor and branching nodes are Phase 2.

## Decision

- **Flows are versioned YAML in `flows/`** (`fix-issue`, `task`), validated with Zod (`packages/contracts`, `FlowDefinition`) and loaded when the daemon starts; an invalid built-in Flow stops it. A run stores a full copy of its Flow and resolved params in `run.created`, so editing the YAML never changes a running run and a replay sees the same definition.
- **Phase 1 Flows are linear:** `edges` is one chain naming every top-level node once. Node types: `trigger` (marks the start; label triggers come later), `agent`, `action` (`verification.run`), `approval`, `loop` (a body of agent/action nodes with `until` and `max_iterations`) and `github` (`pr.create`). `switch`, `parallel`, `join`, `judge`, `subflow` and `llm` are refused with a message naming Phase 2.
- **Expressions** `${{ … }}` use a small grammar evaluated without `eval`: a path rooted at `nodes`, `params` or `project`, a literal, an optional comparison, an optional leading `!`. References to unknown nodes or params fail at load time.
- **The Flow engine is pure** (`packages/flow-engine`, `next()`): from the Flow and the run's tasks it returns start a node, skip a node whose `when` is false (`flow.node.skipped`), wait, done, or fail. The Orchestrator records the result as events and calls it again after each task succeeds, on run creation and on daemon start, so a restart resumes from the event log.
- **Tasks are created when their node becomes due**, carrying `iteration`, `stage` (the run state while it runs, §8.4), `uses` and rendered `inputs`. A loop adds one task per node per iteration. Outputs (`task.completed.outputs`) are what later nodes read: agents give `summary`, verification gives `passed`, `blocking_failures`, `warnings`.
- **Verification succeeds as a task even when checks fail**; the Flow decides. A loop retries until `until` holds or `max_iterations` is reached, then fails the run with the last failures; a node outside a loop that reports `passed: false` fails the run. The run may go back from `verifying` to `executing` for this loop (spec §8.4).
- **Inputs from earlier nodes are data.** They are model output that may carry text from the issue (T1), so they reach agents in delimited `<input name="…">` blocks marked as data, after the task.
- **Profiles** (`triager`, `planner`, `implementer`, `reviewer`) follow §6.3.3. Read-only profiles get a grant without edits and only git's read commands, and no setup commands run for them. All agents of a run share one worktree, named after the Flow (`navarch/<run>/fix-issue`); setup runs once per worktree.
- **Autonomy levels** come from `.navarch/project.yaml` `autonomy_level`, else the daemon's, and are stored on the run. Policy: level 0 asks before any agent task, level 1 before editing agents, below 3 the `fix-issue` Flow asks for the plan (`approval` node, action `flow.approval`) and the PR (`github.pr.create`). Any task can now wait for approval; an exhausted budget denies agent tasks instead of asking.

Differences from the §9.4 example, kept small on purpose: no `worktree` node (the runtime creates the run's worktree), no `${{ trigger.work_item }}` input (the issue is already the task of every agent), and the reviewer uses the run's adapter until the Model Router exists.

## Consequences

- Runs created before Flows keep working: their pre-created tasks run in order (legacy path in the Orchestrator).
- A fix iteration starts a fresh agent conversation with the previous failures as input; adapters' resume prompts only say "continue".
- Every issue run now costs three or four agent calls (triage, plan, implement, review) instead of one; plan approval at levels below 3 stops spending before implementation.
- Branching, parallel implementations and judges (Compete mode) need a graph executor, not a chain: Phase 2 extends `next()` rather than replacing the event model.
