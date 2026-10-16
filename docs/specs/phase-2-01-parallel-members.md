# Phase 2, slice 1: parallel team members

Status: implemented · Branch: `feat/parallel-members` · Spec: §6.5.2, §9.2, §16 · ADR: 0029

Team members whose dependencies are done run at the same time, each in its own worktree, and their work is merged back into the run's shared worktree one member at a time. A conflict goes to an implementer agent; git stays with Navarch.

## Behavior

### The `team` node

- New fields: `parallel` (boolean or expression, default `false` on the node) and `max_parallel` (number or expression, default 3).
- `flows/team.yaml` gains the params `parallel` (bool, default `true`) and `max_parallel` (int, default 3), so team runs are parallel by default. `parallel: false` keeps slice 9's behaviour (one member at a time in the shared worktree).

### A turn in a parallel team

1. Lead turn, first-plan approval: unchanged (slice 9).
2. **Members** of the turn start as soon as every member they depend on is done, plan order first, up to `max_parallel` running at once (the scheduler's `concurrency` still applies). A member is done for its dependants when it succeeded and, for an `implementer`, when its branch was merged.
3. **Own worktree.** A parallel member's task records `team.own_worktree: true`. The Agent Runtime commits what is uncommitted in the shared worktree (as Navarch, `--no-verify`), then creates `navarch/<run>/team-<key>` from that commit in `~/.navarch/worktrees/<repo>/<run>-team-<key>`. A retry reuses the worktree, and its fork point is `git merge-base` with the shared branch. Setup commands run once per member worktree.
4. **Integrate** (task `team.<key>.integrate`, action `team.integrate`, role `integrate`), after an `implementer` member succeeds, one at a time per team:
   - commits the member worktree as Navarch ("team member <key>: <title>"),
   - commits what is uncommitted in the shared worktree,
   - `git merge --no-ff -m "Merge team member <key>"` the member branch into the shared worktree.
   Outputs: `merged: true`, or `merged: false, conflicts: [files]` with the merge left in progress. A branch already merged, or with no commits since its fork, succeeds at once.
5. **Resolve** (task `team.<key>.resolve`, profile `implementer`, role `integrate`) when the merge conflicts. It runs in the shared worktree, routed like a member; its brief lists the conflicted files, the member's title and summary, and asks to remove every conflict marker keeping both intents, without running git.
6. **Integrate, attempt 2** (iteration 2) after the resolve task ended, whatever its status: when none of the conflicted files still holds a marker line (`<<<<<<<`, `=======`, `>>>>>>>` at line start), stages everything and concludes the merge as Navarch; otherwise `git merge --abort` and `merged: false`. A member whose merge failed is reported to the lead as "not merged: conflict in …", and members depending on it are not started.
7. **Verify** and the **next lead turn** wait until every member of the turn is finished and every integration settled. They run in the shared worktree, as before.

### Lock

Navarch's git writes to a repository's worktrees (fork, integrate) run one at a time per repository, inside the daemon.

## Policy

- `team.integrate`: allowed at autonomy ≥ 2, asks a human below (it edits the run's worktree).
- The resolve agent is a `team.delegate` with the implementer's grant.
- A failed integrate or resolve task does not fail the run: the lead reads it next turn, like a failed member.

## Contracts

- `TeamNode.parallel`, `TeamNode.max_parallel`.
- `TeamTaskRole` adds `integrate`; `TeamTaskRef.own_worktree?: boolean`.
- `TeamMemberView.merge: "pending" | "merging" | "resolving" | "merged" | "conflict" | null` (null for read-only members and sequential teams) and `branch: string | null`.
- `GET /api/v1/runs/:id/worktree[?task=]` and `/worktree/diff?path=&task=`: with `task`, that task's worktree; without, the run's shared worktree (its Flow's branch).

## Tests (no network, no real agent)

- Flow engine: independent members start together up to `max_parallel`; a dependant waits for its dependency's merge; integrations run one at a time; conflict → resolve → integrate 2; unresolved conflict skips dependants and reaches the lead; read-only members are not merged; verify waits for every integration; `parallel: false` unchanged.
- Runner: fork from the shared worktree's HEAD with its uncommitted work; merge with and without conflict; conclude or abort after markers are removed or kept.
- Daemon with fake agents: a lead delegates two independent members that run in their own worktrees, both are merged, the checks see both files, the PR branch carries both; a conflicting pair goes through resolve.
- Worktree API with `?task=`.
- Visual check (2026-10-16): demo daemon with the fake lead of `lead-conflict`, the resolver held mid-merge, Chromium 1440×900 dark and light: member cards with "Merged" and "Resolving a conflict", the resolver hanging under member b ("Resolve b's merge conflict"), member a's panel Worktree tab on `navarch/<run>/team-a` with its one file; after release the run ended `done` with both members merged; no console errors. It found and fixed: the resolver first showed as a loose agent under the run, labelled with its node id. `ctk shoot` cannot inject its stylesheet under the daemon's CSP, so the captures used Playwright with `bypassCSP`.

## 🔴 Open

- Generic `parallel`/`join` Flow nodes outside a team, Compete mode and `judge` (next slices).
- ~~Splitting the budget left across members running at once~~: done, ADR 0030.
- Pruning member worktrees when the run ends (§6.5.2 cleanup policy).
