# Team and Compete

Two Flows put several agents on one piece of work.

## Team mode

```sh
navarch run --flow team --repo ~/code/app "Add dark mode to the settings page"
```

A **lead** agent works in turns. Each turn it looks at the task and at what its team did so far, then answers with a plan:

- a short summary and whether the work is done;
- an optional **question** for you, which pauses the team until you answer with `navarch say`;
- the **members** it wants next, each with a key, a brief, a profile (`planner`, `researcher`, `implementer` or `reviewer`), an optional preferred agent, and the members it depends on.

Navarch then runs the members in dependency order. By default, members whose dependencies are done start **in parallel**, up to three at once, each in its own worktree. When an implementer member succeeds, Navarch commits its work and merges it into the team's shared worktree. A merge conflict gets its own resolver agent. Checks run after every turn, and the first plan waits for your approval below autonomy level 3.

The team ends when the lead says it is done and the checks pass. It fails after 8 turns or 12 members. Members get only their brief and short summaries of their dependencies, which keeps their context small.

In the Fleet tree the lead sits above its members, with "delegates", "after" and "reports" links, and **lead chat** shows the conversation across turns.

## Compete mode

```sh
navarch run --flow compete --budget 3 --repo ~/code/app "Speed up the search index build"
navarch run --flow compete --budget 5 --param competitors=4 --issue owner/repo#42
```

The same task goes to **2–5 competitors** (3 by default) at once, each in its own worktree, routed to different providers where possible. Each one has its own implement ⇄ verify loop. A competitor whose checks still fail is out.

Then:

1. **Compare.** Navarch measures every finalist: files and lines changed, protected paths, fix iterations, the diff.
2. **Judge.** A read-only judge, on a provider none of the competitors used, ranks the finalists with reasons. With one finalist, there is nothing to judge.
3. **Pick.** Below autonomy level 3, you approve the judge's first choice or pick another finalist:

   ```sh
   navarch approve <id> --pick c2
   ```

4. **Adopt.** The winner is merged into the run's branch. Losing branches stay local and are never pushed.

The pull request carries the winner's checks, its agent and a Compete section. Compete runs require `--budget`, since several agents spend at once. The run page's **Compete** tab shows every competitor and the judge's ranking.
