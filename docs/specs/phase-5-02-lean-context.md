# Phase 5, slice 2 — lean context

Status: implemented, measured and not met ([report](../reports/2026-10-19-lean-context-campaign.md)). ADR 0070. Spec §6.8.2; follows the Phase 3 go/no-go (token reduction not met).

## Why

The Phase 3 campaign measured +9 % input tokens with the full block (map, symbols, excerpts, mentions) against a −30 % target. Outside work points the same way: repository context files made coding agents explore more and raised cost by over 20 % in a study of several agents (arXiv 2602.11988), and the strongest repository-map design (Aider's) was built for chat models, not for agents that read files whole before editing them. So the block should point, not explain, and appear only where exploring is expensive.

## Behaviour

- `knowledge.context.mode: lean` compiles `## Files most likely involved`: up to 6 files that the task's words reach through symbol names, ranked by how many and how strong the matching terms are (exported names count more), each with up to 4 matched names and `file:line`-style lines, plus the test file beside it when the repository has one. No map, no excerpts, no mentions, no test file listed as the file to change. At most `knowledge.context.lean_max_tokens` (600) tokens, header included. Nothing matched means no block. `mode: full` (default) is ADR 0043's block, unchanged.
- `knowledge.context.profiles` limits which profiles carry it (empty: all of ADR 0043's), and `knowledge.context.min_complexity` skips a run whose triage said `Complexity` below it; a run that was not triaged still gets the block.
- The block keeps the same `<context>` wrapper, untrusted marking, `context.compiled` event and token metrics (`MetricsView.knowledge`), so the existing panel measures it.

## Acceptance

- Unit: the lean block lists the matching file with names and lines, the test beside it, never a test as the target, stays within its budget and is absent when nothing matches.
- Measurement (done 2026-10-19, not met: +1 %, +4 %, +13 %): on a repository large enough that exploring costs, tasks of complexity 3+ with the block off against lean, success not lower and median input tokens per attempt reported by `navarch metrics`. `enabled` stays `false` unless it is met.

## Not in this slice

- Pull tools for agents through MCP (slice 5 of Phase 3 exposes them to external agents; Navarch does not yet attach them to its own agent runs).
- Changing the default `mode` or `enabled`.
