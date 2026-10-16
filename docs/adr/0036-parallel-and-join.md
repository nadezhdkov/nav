# 0036 — Generic `parallel` nodes with a `join` mode

- Status: accepted
- Date: 2026-10-16
- Spec: §6.2.1 (`parallel` / `fan-out`, `join`), §6.2.3 (Flow Studio), §8.3 (task states), §16 (Phase 2)
- Slice: [`docs/specs/phase-2-06-parallel-join.md`](../specs/phase-2-06-parallel-join.md)
- Builds on: ADR 0011 (linear Flows), ADR 0022/0029 (Team mode, parallel members), ADR 0031 (Compete mode), ADR 0033 (Flow Studio)

## Context

§6.2.1 lists `parallel` / `fan-out` ("starts N branches") and `join` ("waits for branches: `all`, `any`, `quorum:n`") as separate node types. The engine runs one linear chain of nodes (ADR 0011), and parallel work exists only inside composite nodes: Team mode's parallel members and Compete mode's competitors, each in its own worktree with a merge back (ADR 0029, 0031). Flows still had no general way to run independent steps together, such as two reviews from different angles, or several researchers answering separate questions before a plan.

Two questions decide the design: how branches and their join appear in a linear chain, and what branches may do to the run's single shared worktree.

## Decision

1. **One composite `parallel` node with a `join` field**, not two node types. It holds `branches`, a map from a branch name to a list of agent or action nodes run in order, with 2 to 8 branches. `join` is `all` (the default), `any` or `quorum:N`. In a linear chain a standalone `join` could only ever close the `parallel` right before it, so it would add a node and an edge that say nothing. A `join` node in a Flow gets a message pointing to the field.
2. **Branch nodes keep their own ids**, unique in the Flow like a loop's body. Tasks are created under those ids with `task.created.parallel = { node_id, branch }`. Later nodes read `nodes.<branch node>` directly, and a branch node reads earlier nodes of its own branch, never another branch's (the checker refuses it). The parallel node's own outputs, once joined, are `summary` (every succeeded branch's last agent summary under `### <branch>`), `succeeded`, `failed` and `branches`.
3. **Branches are read-only.** They share the run's worktree, so an editing profile in a branch is refused when the Flow is checked (Studio validation and publish) and again when the task would start. Editing in parallel needs a worktree per branch and a merge, which Team and Compete mode already do. A generic version would bring those merges into every Flow, and nothing asks for it yet.
4. **The join stops what it no longer needs.** Once enough branches succeeded, or so many failed that the join can no longer be met, the engine returns a new step, `cancel`, naming the active branch tasks. The Orchestrator cancels the ones not yet running, and the Scheduler stops the running ones through a new `requestStop`, which ends them `cancelled` without cancelling the run. The node then finishes, or fails with each branch's reason. `all` fails at the first failed branch.
5. **The Flow, not the Scheduler, weighs a branch's failure.** A branch task that fails for good no longer fails the run at once: the Scheduler advances the run, and the join decides. This rule now covers every task whose failure the Flow weighs. That includes Compete's competitors: a competitor whose agent failed used to fail the run, which the next dispatched competitor then moved back to `executing`, against ADR 0031's "a competitor whose agent fails is out".
6. **The run's worktree is created once.** Branches may be a run's first agents, all starting together, so creating the shared worktree now goes through the per-repository queue of Navarch's git writes (ADR 0029).
7. **Simulation starts branches together.** The simulator finishes started tasks only once the engine has nothing more to start, which is how a run behaves, and records `cancelled` steps for branches a join stopped.

## Consequences

- A Flow can run independent read-only steps at once, and the Flow Studio offers a parallel node with two review branches, a `join` field and a read-only list of branches. Branches themselves are edited in the YAML view.
- Run status stays on the main sequence: concurrent branches with different stages only move the run forward.
- Open: editing branches with their own worktrees and merges, branches holding loops or approvals, and a dedicated graph layout that draws each branch as its own lane.
