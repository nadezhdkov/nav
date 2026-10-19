# Lean context campaign, 2026-10-19

Repository: the Navarch repository itself at `c8bd9d7` (about 28 packages), cloned with a `.navarch/project.yaml` (setup `pnpm install`, verify `tsc`). Agent: `claude-code`, pinned, `task` Flow, billed cost $0. Three medium enhancement briefs (relay `/healthz` channel count, `last_seen_at` on devices, `next_run_at` on schedules), each run once with the block off and once with `knowledge.context.mode: lean` for the implementer. One daemon home, so `navarch metrics` compared both sides.

## Result: not met

| Task | Off (tokens in, fresh + cached) | Lean | Change |
|---|---|---|---|
| relay `/healthz` | 406k | 412k | +1 % |
| device `last_seen_at` | 686k (second attempt, the first hit a rate limit) | 716k | +4 % |
| schedule `next_run_at` | 555k | 626k | +13 % |

`navarch metrics`: 626.5k with the block against 480.7k without, +30 %, against a target of −30 %; the panel's median compares 3 attempts with 4 (the rate-limited one counts on the "without" side, which flatters it less than the paired table above does). Success 100 % on both sides. The block was about 111 tokens: the files were found, and the agent still read and searched as much. Runs took 30–85 s, so these tasks were easy for the agent even in a large repository.

## Verdict

Lean context does not reduce input tokens here: at best it is neutral, at worst it adds a little. Together with the first campaign (+9 % with the full block) and the outside evidence (arXiv 2602.11988), a pushed block does not pay for itself with Claude Code. `knowledge.context.enabled` stays `false`. Sample: 3 pairs, one agent, one repository; a difference of 30 % in the other direction would still show, so this is a no-go for the pushed block rather than proof for any size of task.

Open: the other direction, giving agents pull tools (MCP `repo_search`, `repo_symbols`) on their own runs, was not tried.
