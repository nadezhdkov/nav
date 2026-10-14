# Phase 1, slice 2: Flow engine and the `fix-issue` Flow

Status: implemented · Branch: `feat/flow-engine` · Spec: §6.2, §6.3.3, §7.1, §8.3–8.4, §9.4, §11, §14.2 · ADR: 0011

Replaces slice 1's fixed chain with Flows in YAML. An issue run now follows §7.1: triage, plan, a human approves the plan, implementation and verification loop until the checks pass, a reviewer reads the change, and a draft PR is opened.

## Behavior

```
navarch run --issue owner/repo#42 --repo ~/src/repo        # Flow fix-issue
navarch run "add a --json flag to export"                   # Flow task
navarch run --flow <name> …                                 # any Flow in flows/
navarch approvals / approve <id> / reject <id>              # plan, editing (level 1), PR
```

`flows/fix-issue.yaml`:

| Node | Type | Run state | Notes |
|---|---|---|---|
| `start` | trigger | | marks the start; label triggers come in a later slice |
| `triage` | agent `triager` (read-only) | planning | kind, complexity, likely areas |
| `plan` | agent `planner` (read-only) | planning | gets the triage; its summary is the plan, also saved as a `plan` artifact |
| `approve_plan` | approval, `when: project.autonomy_level < 3` | awaiting_approval | shows the plan; rejecting cancels the run |
| `implement_loop` | loop, `until: nodes.verify.outputs.passed`, `max_iterations: params.max_fix_iterations` (3) | | |
| ↳ `implement` | agent `implementer` | executing | gets the plan and, from the 2nd iteration, the previous blocking failures |
| ↳ `verify` | action `verification.run` | verifying | outputs `passed`, `blocking_failures`, `warnings` |
| `review` | agent `reviewer` (read-only) | reviewing | two axes (Standards, Spec) against the plan |
| `open_pr` | github `pr.create` | ready_for_pr → pr_opened | the PR body adds the plan, the review and the number of attempts |

`flows/task.yaml` (prompt runs): `implement_loop` only, no PR.

## Rules

- The run stores its Flow and params (`run.created.flow`) and its autonomy level (`run.created.autonomy_level`: `.navarch/project.yaml` `autonomy_level`, else the daemon's).
- Tasks are created when due (`task.created` with `iteration`, `stage`, `uses`, `inputs`); `task.completed.outputs` feeds later nodes. A `when` that is false records `flow.node.skipped`.
- Inputs reach agents after the task, in `<input name="…">` blocks marked as data (T1); closing tags inside are neutralised.
- Read-only profiles: no file edits, only `git status|diff|log|show`, no setup commands. All agents share the run's worktree `navarch/<run>/<flow>`; setup runs once per worktree.
- Policy (§11): level 0 asks before any agent; level 1 before editing agents; `flow.approval` always asks; `github.pr.create` asks below level 3; an exhausted budget denies agent tasks.
- A loop that runs out of iterations fails the run with the last blocking failures; a node outside a loop that reports `passed: false` fails it too.
- Run state machine: `verifying → executing` is allowed for the fix loop.
- Restart: after a task succeeds the Orchestrator advances the run; on start it advances every non-terminal run, so a stop between the two is recovered.

## Tests (no network)

- `packages/flow-engine`: expression grammar and refusals; built-in Flows load; Phase 2 node types, unknown references, broken chains, unknown operations and duplicate ids are refused; `next()` order for `fix-issue` at levels 2 and 3; loop exhaustion; previous failures passed as input; wait and fail; input delimiting.
- Daemon end to end with the fake Claude (`flow` scenario answers per profile): plan approval then PR approval with the full task order and run states; level 3 with no approvals and `approve_plan` skipped; the fix loop (two implement iterations, the second sees the first's failures, read-only profiles cannot edit); three failed iterations fail the run before review and PR; level 1 from `project.yaml` asks before `implement`; rejecting the plan cancels the run; a daemon restart while the plan waits.

## 🔴 Open

- The reviewer uses the run's adapter; "a different provider" (§6.3.3) needs the Model Router.
- The reviewer's verdict does not gate the PR yet; it is shown in the PR body for the human.
- Verify and setup commands still run unsandboxed as the operator (ADR 0006): fine for the operator's own repositories, not for automatic third-party issues.
