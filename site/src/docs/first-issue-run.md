# Your first issue run

An issue run takes a GitHub issue to a verified draft pull request. It needs a GitHub token and a local clone of the repository.

## 1. Give Navarch a GitHub token

Create a **fine-grained personal access token** limited to the repositories you want Navarch to work on, with these permissions: **Metadata** (read), **Contents** (read and write), **Issues** (read) and **Pull requests** (read and write). Then store it:

```sh
navarch secret set github/token
```

The token goes to your OS keychain, never to a file, a log or an event. Navarch reaches GitHub only through its GitHub Integration, and pushes only `navarch/*` branches, never forced.

Before a run that ends in a pull request starts, Navarch checks with a `git push --dry-run` that the token may push to the repository, which writes nothing. A token without write access stops the run before any agent works.

## 2. Register the repository (optional)

```sh
navarch project add ~/code/repo
```

A registered project gets its issues polled into the **Inbox**, where each new issue is triaged and estimated. You can also clone a repository the token reaches with `navarch project clone owner/name`.

## 3. Start the run

```sh
navarch run --issue owner/repo#42 --repo ~/code/repo
```

The run follows the `fix-issue` Flow:

| Step | Who | What you see |
|---|---|---|
| Triage | a fast agent | kind of work and complexity, 1–5 |
| Plan | a planner | the plan, waiting for your approval |
| Implement ⇄ verify | an implementer and your checks | the live diff, up to 3 fix iterations |
| Review | an agent from another provider | a verdict on the change |
| Draft PR | the GitHub Integration | waits for your approval, then opens |

## 4. Approve

```sh
navarch approvals
navarch approve <approval-id>
navarch reject <approval-id> --reason "Plan misses the migration"
```

Or open `navarch web` and decide on the Approvals screen, which shows what will happen, why it needs you and what the run has cost so far. A paired phone gets a push notification.

Where approvals happen depends on the repository's [autonomy level](/docs/autonomy-and-approvals).

## 5. Review and merge

The draft pull request carries the plan, the checks that ran, the agents that worked on it, the cost and any open 🔴 items. Review it like any other pull request. **Merging is always yours.**
