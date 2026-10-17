# How it works

Navarch is one daemon, `navarchd`, with several clients: the CLI, the Web UI, your phone and the concierge. They all talk to the same Core API on `127.0.0.1`, and none of them holds business logic of its own.

## Runs, Flows and tasks

- A **Flow** is a versioned YAML definition of what a run does: its nodes (agents, checks, approvals, GitHub actions, loops) and the edges between them. The built-in Flows live in `flows/`.
- A **run** executes one Flow on one repository. It keeps its own copy of the Flow, so editing a Flow never changes a run in progress.
- Each node that becomes due turns into a **task**: an agent attempt, a verification, an approval, a pull request. The run's live **task graph** in the Web UI is drawn from those tasks.

See [Flows](/docs/flows) for the built-in Flows and how to write your own.

## Worktrees

Every run works on its own branch, `navarch/<run-id>/<flow>`, in a git worktree under `~/.navarch/worktrees/<repo>/`. All the agents of a run share that worktree, except members of a parallel team and Compete competitors, which each get their own and are merged back by Navarch.

Your checkout is never touched, and you can open any run's worktree to look at what the agents did.

## Agent profiles

Each agent node has a profile that sets its role and what it may do:

| Profile | Role | Edits files |
|---|---|---|
| `triager` | classifies the work and its complexity | no |
| `planner` | writes the plan | no |
| `implementer` | changes the code | yes |
| `reviewer` | reviews the result | no |

Team, Compete and pull-request Flows add a few more (`lead`, `researcher`, `judge`, `pr-reviewer`, `ci-fixer`).

## The Policy Engine

Every side effect asks the Policy Engine first: starting an agent, running a command, pushing a branch, opening a pull request, posting a review. The scheduler never hands a task to an agent without its decision. The answer is *allow*, *deny*, or *ask a human*, which becomes an approval. See [Autonomy and approvals](/docs/autonomy-and-approvals).

## Everything is an event

State is derived from an append-only event log in a local SQLite database: `run.created`, `task.created`, `model.routed`, `approval.requested`, `budget.threshold`, `github.pr.opened`, and so on. The Web UI and the CLI read projections of that log, and the run timeline is the log itself. Nothing an agent did is lost or rewritten.

## Resilient by design

- **Restarts.** Interrupted tasks are dispatched first when the daemon comes back. Agents that support it resume their own conversation.
- **Quotas.** When an agent runs out, the task waits for the reset the agent reported and continues. A reset more than 12 hours away pauses the run until you resume it. See [Budgets and quotas](/docs/budgets-and-quotas).
- **Retries.** A failed run can be resumed. Its failed tasks go back to ready and keep their approvals, and finished tasks are kept.
