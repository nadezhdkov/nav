# 0031 — Compete mode: N competitors in their own worktrees, a judge, and a human pick

- Status: accepted
- Date: 2026-10-16
- Spec: §6.2.1 (`judge`), §6.3.3 (profile `judge`), §7.2 (Modo Compete), §11 T6 (runaway spend), §16 (Phase 2), §19 idea 15
- Slice: [`docs/specs/phase-2-02-compete-mode.md`](../specs/phase-2-02-compete-mode.md)
- Builds on: ADR 0011 (Flow engine), ADR 0013 (Model Router), ADR 0029 (worktree fork and merge), ADR 0030 (budget holds)

## Context

§7.2 draws Compete mode with generic nodes: `fan-out ×3`, a worktree action and an agent per branch, `join: all`, `judge`, `approval` and the PR. The Flow engine still runs one linear chain (ADR 0011), and generic `parallel`/`join` nodes need branch-scoped expressions that nothing else needs yet. Team mode (ADR 0022) already showed a different approach: one composite node that derives its tasks from the run's tasks, built on the worktree fork and merge of ADR 0029.

Three questions are open: how the competitors come to differ, what the judge sees, and how a human overrides the judge.

## Decision

1. **A composite `compete` node** in the linear chain, like `team`. It holds:
   - N competitors (`<id>.c<i>`), each with its own verify and fix loop
   - a deterministic comparison (`<id>.compare`)
   - the judge (`<id>.judge`)
   - a pick approval below autonomy level 3 (`<id>.approve_pick`)
   - an adoption merge (`<id>.adopt`)

   Generic `parallel`/`join`/`judge` nodes stay open. When they arrive they can reuse the same pieces.
2. **Competitors differ by agent.** Every competitor is routed, even in a pinned run. The Model Router puts first the providers no other competitor of the node uses, then the catalog entries no other competitor uses (`RouteRequest.spread`). With one usable agent, Compete degrades to best-of-N of the same model, which is still useful. Each competitor forks its own worktree from the shared worktree's HEAD (ADR 0029), so all of them start from the same commit.
3. **Only finalists are judged.** A finalist is a competitor whose last checks passed. Code that fails the required checks cannot become the PR, so judging it would spend an expert call for nothing. With no finalist the node fails. With one, there is nothing to compare and the judge is skipped.
4. **The judge sees facts gathered by Navarch, not its own exploration.** `compete.compare` is a read-only action that computes, for each finalist from its fork point, the changed files with lines added and removed, the protected paths it touched, the fix iterations it needed and its diff (capped). The judge reads these and each finalist's summary in its prompt. It runs read-only in the shared worktree and is routed to a provider other than the competitors' when one is usable (`judge` joins `routing.different_provider`), which keeps a model from judging its own work. Its verdict is a validated `navarch-judge` block that ranks every finalist with a score and a reason. Invalid twice in a row fails the node.
5. **A human pick is an approval with choices.** `approval.requested` may carry `choices`, and `approval.decided` a `choice`, which must be one of them. The pick approval lists the finalists with the judge's first as the default. Approving without a choice keeps the judge's pick, and approving with one overrides it (spec §7.2, "o usuário pode escolher outro vencedor"). Choices are generic: any later approval that picks among options can use them.
6. **The winner is merged, the rest are kept.** `compete.adopt` commits the winner's worktree as Navarch and merges its branch into the run's shared worktree with `--no-ff`. The shared worktree has no edits of its own since the competitors forked (the judge is read-only), so the merge cannot conflict. Losing branches stay local and are never pushed. `compete.adopt` is a policy action allowed from autonomy level 2, like `team.integrate`.
7. **Compete needs an explicit run budget.** N competitors multiply the cost (§7.2, T6), so a run whose Flow has a `compete` node is refused without `--budget` (`budget_required`). Billed competitors running at once split what is left of it (ADR 0030).
8. **Flow params from the caller.** A run can set its Flow's params (`CreateRunRequest.params`, `--param name=value`), checked against their declared types. This sets the number of competitors and is open to every Flow.

## Consequences

- Compete costs about N implementations plus one expert call, and N worktrees, each running the project's `setup`. The budget requirement makes that cost a conscious choice. Plan-billed agents are still bounded by their quotas.
- The Phase 2 go/no-go criterion, "the user agrees with the judge in ≥ 70 % of test cases", is measurable from events: `approval.decided` carries the `choice`, and the pick's task outputs say whether it matched the judge.
- `judge` becomes a profile and a routing tier entry (`expert`). `TaskCreated` gains `compete` (`CompeteTaskRef`), and `RunDetail` gains `compete` (`CompeteView`) for the UI.
- The verify action learns to run in a competitor's own worktree. The worktree API's `?task=` already reads any task's worktree.
- Open: a user-given model per competitor, the "improve the prompt" `llm` node of §7.2, and pruning losing worktrees.
