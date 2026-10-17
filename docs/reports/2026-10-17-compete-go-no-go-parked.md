# Compete go/no-go — parked, 2026-10-17

**Criterion (spec §16, Phase 2):** Compete mode picks, by the user's own judgement, the best implementation in ≥ 70% of test cases.

**Verdict: not decided. The campaign was stopped by the user after 2 of 10 cases, and Compete is left out of regular use.** The criterion is neither met nor failed. Phase 2's other go/no-go criterion (a Flow made only in the UI) was met in [2026-10-16-flow-studio-go-no-go.md](2026-10-16-flow-studio-go-no-go.md).

## Why it was stopped

Compete runs the same task on 2–5 agents and adds a judge, so one task costs about 3–4 times the quota of a single run. On the small, well-defined tasks of this campaign, a single agent is usually enough, so the extra cost is unlikely to pay off. The user chose to stop spending quota on the validation and to revisit Compete later, for something more specific (for example hard or ambiguous tasks, where one agent often fails).

The code, ADR 0031 and the `compete` Flow stay as they are. Nothing was removed.

## Cases judged (blind, on claude-toolkit, prompt runs, nothing pushed)

| Case | Agents (A/B/C) | User | Judge's first pick | Result |
|---|---|---|---|---|
| 01 `ctk lsp` JSON output (calm-ferry) | claude-code, copilot, claude-code | tie | c1 (A) | not counted |
| 02 `ctk runq` mypy digest (witty-knarr) | claude-code, claude-code | A (c1) | c3 (B) | judge missed |

Two cases are too few for a rate: 0 hits, 1 miss, 1 tie. The other eight were cancelled or failed (see F-copilot) and were never rerun.

## Findings

- **F-copilot (fixed, #54).** Copilot CLI denied every allowlisted multi-word command (`make lint`), so Copilot competitors could never run the project's checks. Found only because the campaign ran for real.
- **F-sched.** Dispatch is FIFO by ready time across runs. With 10 Compete runs queued, every implement task goes before any `compete.cN.verify`, so no run reaches the judge until nearly all competitors of all runs have implemented. Finishing runs already in progress first, or a separate limit for non-agent tasks, would fix it.
- **F-spread.** With only two providers usable, `spread` ended with two competitors on the same agent and model, which are near-duplicates and make the comparison less informative.
- **F-view.** A fix iteration that is ready but not yet dispatched shows the run's default adapter instead of the one it will be routed to (`orchestrator.ts` placeholder on `task.created`).
- **F-quota.** Claude Code's `seven_day` window was at 90 %, so `routing.quota_reserve` put it last and 8 of 10 runs went to Copilot three times over.

F-sched, F-spread and F-view are open and only matter when Compete is used again.
