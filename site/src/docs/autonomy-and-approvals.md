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

## Away mode

When you are busy on something else, runs can wait for you for hours. **Away mode** hands some approvals to an **approver agent** for a while, so the run keeps going until the draft PR. It is off by default and only you can turn it on, from the desktop Web UI (`/away`) or the CLI:

```sh
navarch away on --for 4h --delegate plan,pr --max-complexity 3
navarch away          # what it decided, and why
navarch away off
```

You choose what to hand over (the plan, opening the draft PR, starting agents), for how long, how complex a run may be, and how many times it may send a plan back. Turning it on shows a warning and needs an explicit yes. A banner stays on every screen while it is on.

For each approval it was handed, the approver reads the plan (or the finished change) and answers:

- **approve**: the run goes on, and the decision is recorded as the approver's.
- **send back**: the planner redoes the plan with the approver's feedback, then the new plan is judged.
- **leave to you**: the approval waits as usual and your phone is notified.

It is an AI model, so it can be wrong; what it approves still ends as a draft PR that you review and merge. It never merges, never raises a budget and never decides anything you did not hand over. Runs above your complexity limit, and PRs whose checks failed, always wait for you.

## Auto-merge

Off by default and per repository. Only you can turn it on, from the CLI or the desktop (never from a phone or by an agent), by typing the repository's name after reading the conditions:

```sh
navarch automerge                                   # conditions and each project's state
navarch automerge on owner/repo --confirm owner/repo
navarch automerge off owner/repo
```

It needs autonomy level 3 or higher. Navarch then merges one of its own pull requests only when all of these hold: the verification passed with checks configured, the reviewer approved with no blocking finding and no 🔴 item, the head is the commit Navarch pushed, GitHub's checks are all green (and there is at least one), the target is the default branch and it is **not protected**, no dependency manifest, lockfile, workflow or protected path changed, and the run is within its budget. Anything unknown means no merge. The stop-everything button turns it off in every project, and each merge is recorded with its reason. The GitHub token needs Pull requests and Contents write access.
