# Autonomy and approvals

Each repository decides how much a run may do before a human looks. That is its **autonomy level**, set in `.navarch/project.yaml` (or, if absent, in the daemon's config):

| Level | A human approves… |
|---|---|
| 0 | before every agent starts, plus the plan and the pull request |
| 1 | before any agent edits files, plus the plan and the pull request |
| 2 | the plan and the pull request (the default) |
| 3 | nothing in the default Flows: plan and PR go ahead |

Below level 3, `fix-issue` stops twice: once to approve the plan, once before opening the draft pull request.

```yaml
# .navarch/project.yaml
autonomy_level: 2
```

The file is read at the run's base commit, never from the agent's worktree, so an agent cannot raise its own autonomy.

## What an approval shows

Every approval says **what will happen** (the plan, the pull request), **why it needs you**, and **what the run has cost so far**. Some approvals offer choices: in Compete mode you keep the judge's pick or choose another finalist.

## Deciding

From the CLI:

```sh
navarch approvals                       # pending approvals
navarch approvals --all                 # including decided ones
navarch approve <id>
navarch approve <id> --pick c2          # an approval with choices
navarch reject <id> --reason "Too broad; split the migration out"
```

From the Web UI, the **Approvals** screen. From your phone, the push notification opens the same screen. A notification never approves anything by itself.

## Other gates

- **Budgets.** When a run, project or month budget is used up, the next agent task waits for a `budget.exceed` approval. Raising the limit approves the waiting tasks. See [Budgets and quotas](/docs/budgets-and-quotas).
- **Commands.** A command outside the project's allowlist is denied. Add it to `allowlist` in `.navarch/project.yaml`, or allow it for one run with `--allow "<cmd>"`.
- **Pull request writes.** Posting a review or a comment on a pull request is a policy action of its own, approved below level 3.

## Steering a run

Approving is not the only way in. You can send any run an instruction:

```sh
navarch say brave-frigate "Use pnpm, not npm"           # in the next agent turn
navarch say brave-frigate --now "Stop, the API changed"  # interrupts and resumes the agent
navarch pause brave-frigate
navarch run resume brave-frigate
navarch stop --all                                       # pause every active run
```

Instructions never widen what an agent is allowed to do.
