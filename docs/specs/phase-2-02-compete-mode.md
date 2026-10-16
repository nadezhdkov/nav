# Phase 2, slice 2: Compete mode and the judge

Status: in progress · Branch: `feat/compete-mode` · Spec: §6.2.1 (`judge`), §6.3.3 (profile `judge`), §7.2, §16, §19 idea 15 · ADR: 0031

The same task goes to N agents at once, each in its own worktree. Each one implements, verifies and fixes on its own. A `judge` agent compares the results that pass the checks and ranks them with reasons. Below autonomy level 3 a human confirms the winner or picks another one. The winner's branch is merged into the run's worktree, and the run goes on to the review and the draft PR.

## Behavior

### The `compete` node and Flow

- New node type `compete` with these fields:
  - `competitors` (number or expression, 2–5)
  - `max_fix_iterations` (number or expression, default 2)
  - `judge: { profile }`
  - `approve_pick` (boolean or expression, default `false`)
- `flows/compete.yaml` has the params `competitors` (3) and `max_fix_iterations` (2). Its chain is `compete -> review -> open_pr`, where `open_pr` runs only when the run has a work item. Start it with `--flow compete` from the CLI, New run, Inbox or the concierge.
- **Flow params from the caller.** `CreateRunRequest.params` sets a Flow's params, and the CLI does the same with `--param name=value`. Each value must name a param of the Flow and match its type (`int`, `money`, `bool`, `string`). For example, `navarch run --flow compete --param competitors=2 --budget 3 "…"`.
- **A compete run needs an explicit run budget** (spec §7.2: "custo multiplicado — exige orçamento explícito"). Without `--budget`, starting the run fails with `budget_required` (400).

### Tasks of a compete node `<id>`

1. **Competitors** `<id>.c1` … `<id>.cN` (profile `implementer`, role `competitor`, key `c<i>`) start together, within the scheduler's `concurrency`. Each works in its own worktree, `navarch/<run>/<flow>-c<i>`, forked from the run's base commit, or from the shared worktree's HEAD when an earlier node already worked there (`forkWorktree`, ADR 0029). Each competitor runs its own fix loop: `<id>.c<i>.verify` runs in that competitor's worktree, and after failed checks iteration *k+1* of `<id>.c<i>` gets the blocking failures, up to `max_fix_iterations`. A competitor whose agent fails, or whose checks still fail at the limit, is out. It does not fail the run.
2. **Routing.** Competitors are always routed, even in pinned runs, as team members are. The Model Router puts first the candidates whose provider no other competitor of the node uses, then the catalog entries no other competitor uses, then the rest (`RouteRequest.spread`). A competitor's fix iterations prefer the agent of its first iteration.
3. **Compare** `<id>.compare` (action `compete.compare`) starts once every competitor has finished. It is read-only and deterministic. For each **finalist** (a competitor whose last checks passed) it reads, from its fork point:
   - the files changed, with lines added and removed
   - the protected paths it touched
   - its diff, capped at 12,000 characters per finalist
   - the fix iterations it needed
   With no finalist the node fails ("no competitor passed the checks"). With one, the judge is skipped.
4. **Judge** `<id>.judge` (profile `judge`, read-only, tier `expert`, routed to a provider other than the competitors' when one is usable). Its inputs are each finalist's summary (capped at 2,000 characters) and the comparison. It ends with a fenced `navarch-judge` JSON block:
   - `summary`
   - `ranking`: every finalist exactly once, best first, each with `competitor`, `score` (0–10) and `reason`

   `parseJudgeVerdict` in `packages/contracts` validates it. An invalid block gets one more judge turn with the error. A second invalid block fails the node.
5. **Pick** `<id>.approve_pick` (an approval, below autonomy level 3) shows the judge's ranking with each finalist's agent, checks and metrics. Its **choices** are the finalists, and the judge's first one is the default. Approving may name another finalist (`choice`). Rejecting cancels the run as any approval does. The judge, the pick and the adoption keep the run in `reviewing`, because the run's states only go back from verifying to executing (§8.4). The pick is a pending approval like any other: it is listed and pushed.
6. **Adopt** `<id>.adopt` (action and policy action `compete.adopt`, allowed from autonomy level 2) commits the winner's worktree as Navarch. It then merges the winner's branch into the run's shared worktree with `--no-ff` ("Adopt competitor c2"), creating that worktree first when no earlier task did. The other branches and worktrees are kept until the run ends, for inspection.
7. The node's outputs are `summary` (the winner's summary and why it won) and `winner`. The reviewer and the PR read the shared worktree as usual. The PR body gains a "Compete" section with the ranking and who chose the winner.

### Approvals with choices

- `approval.requested` gains an optional `choices: string[]`, and `approval.decided` an optional `choice`.
- `POST /api/v1/approvals/:id` accepts `choice`, which must be one of the approval's choices. It is only accepted with `approve`.
- `ApprovalView.choices` and `ApprovalView.choice` carry them to the CLI and the Web UI.
- `navarch approve <id> --pick <choice>`. The Web UI's approval card lists the choices as radio buttons, with the judge's pick selected.

## Policy

- `compete.compare`: always allowed (it reads git only).
- `compete.adopt`: allowed at autonomy ≥ 2, asks below, like `team.integrate`.
- The competitor and judge agents are `task.start` as usual. Running billed competitors split the budget left (ADR 0030).

## Contracts

- `CompeteNode` in `FlowNode`. `judge` stays a Phase 2 node type of its own, since the judge is part of `compete`.
- `CompeteTaskRef { node_id, role: competitor|verify|compare|judge|approval|adopt, key? }` on `task.created` (`compete`).
- `JudgeVerdict`, `parseJudgeVerdict`.
- `CompeteView` on `RunDetail.compete`, with the competitors (key, status, adapter·model, iterations, passed, branch, rank, score, reason), the judge's summary, the winner and `chosen_by` (`judge`, `user`, `only_finalist`).
- `RouteRequest.spread`.

## Tests (no network, no real agent)

- Flow engine: N competitors start together; a competitor's fix loop; an agent that failed is out while the others go on; compare waits for all of them; no finalist fails the node; one finalist skips the judge; an invalid verdict gets one more turn and a second one fails; a pick approval below level 3 with the finalists as choices; a choice overrides the judge; adopt; outputs.
- Contracts: `parseJudgeVerdict` (missing or duplicated finalists, unknown competitor, score range, last block wins).
- Router: `spread` puts other providers first, then other entries, and falls back to the rest.
- Approvals: a choice outside the choices or with a reject is refused (400), and the choice reaches the task's outputs.
- Daemon end to end with fake agents: three competitors where one fails its checks. The judge ranks the other two, the user picks the second, its file is in the shared worktree and the PR branch, and the loser's file is not. A run without a budget is refused.

## 🔴 Open

- A per-competitor `prefer` list (models A, B, C chosen by the user) — routing spreads providers on its own for now.
- The "improve the prompt" `llm` node of §7.2 before the fan-out.
- Pruning losers' worktrees when the run ends (§6.5.2 cleanup policy, also open for team members).
