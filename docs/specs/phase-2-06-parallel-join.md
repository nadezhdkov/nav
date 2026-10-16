# Phase 2, slice 6: generic `parallel` nodes and `join`

Status: implemented · Branch: `feat/parallel-join` · Spec: §6.2.1, §6.2.3, §16 · ADR: 0036

A Flow can run independent read-only steps at once: a `parallel` node holds named branches, each a short sequence of agent or action nodes, and its `join` field says when the node is done.

## Behavior

### The node

```yaml
- id: reviews
  type: parallel
  join: all            # all (default) | any | quorum:N
  branches:
    security:
      - { id: threats, type: agent, profile: researcher }
      - { id: audit, type: agent, profile: reviewer, inputs: { threats: "${{ nodes.threats.outputs.summary }}" } }
    standards:
      - { id: style, type: agent, profile: reviewer }
- { id: report, type: agent, profile: planner, inputs: { reviews: "${{ nodes.reviews.outputs.summary }}" } }
```

- **Shape:**
  - 2 to 8 branches, each a non-empty list of `agent` or `action` nodes run in order. A node may have `when`; when it is false, the node is skipped and its branch goes on.
  - Branch node ids are unique in the Flow.
- **What a node may read:** a branch node reads the nodes before the parallel node and the earlier nodes of its own branch. It never reads another branch's nodes. Nodes after the parallel node read any branch node and the node's outputs.
- **Read-only branches:** branches run read-only agents (`researcher`, `reviewer`, `planner`, `triager`, …) and `verification.run` in the run's worktree. A Flow whose branch uses an editing profile is refused by the checker (Flow Studio, publish) and, as a guard, when the task would start.
- `when` on the parallel node skips the whole node.
- A standalone `join` node is refused with a message that points to the field.

### Running

- **Start:** every branch's first node starts in the same pass of the Orchestrator, within the Scheduler's `concurrency`. Each branch then runs its next node when the previous one succeeded.
- **Task records:** tasks carry `task.created.parallel = { node_id, branch }`.
- **Join:**
  - `all` needs every branch.
  - `any` needs one branch.
  - `quorum:N` needs N branches. N may not exceed the number of branches.
- **A branch fails** when one of its tasks fails for good or reports `passed: false`. A failure does not fail the run by itself: the join decides.
- **When the join is met, or can no longer be met**, the branches still working are stopped:
  - tasks not yet running are cancelled at once;
  - running agents are stopped by the Scheduler and end `cancelled`, with the reason `not needed: <node> joined (<join>)` or `not needed: <node> can no longer join (<join>)`.

  The run is not cancelled.
- **Outcome:** once nothing is active, the node is done, or it fails the run with `<node>: S of N branch(es) succeeded, <join> needs K; <branch>: <reason>; …`.
- **Outputs**, once joined:
  - `summary`: each succeeded branch's last agent summary, under `### <branch>`
  - `succeeded` and `failed`: branch names
  - `branches`: each branch's state and summary
- **Progress** counts the node as one step.
- **Fix in the same slice:** the same rule (the Flow, not the Scheduler, weighs the failure) now applies to Compete's competitors. A competitor whose agent failed used to fail the run for a moment, before the next competitor moved it back.

### Flow Studio and the run page

- **Library:** "Parallel" adds a node with two review branches (`security`, `standards`) and `join: all`.
- **Properties:** `join` (with suggestions `all`, `any`, `quorum:2`) and a read-only list of branches. Branches are edited in the YAML view.
- **Canvas:** the node shows `N × · <join>`. Problems and simulated steps of its branch nodes light it.
- **Simulation:** the branches start together; a branch a join stopped is shown as "stopped".
- **Run page:** the TaskGraph draws the node as one node with the state of its branches' tasks. Its panel lists each branch task with its branch and status.

## Out of scope (🔴)

- Editing branches, each in its own worktree with merges (Team and Compete mode cover editing in parallel).
- Loops, approvals or nested composites inside branches.
- A lane per branch on the canvas.
