# Phase 3 go/no-go (partial), 2026-10-19

Repository: claude-toolkit. Agents: `claude-code` (token campaign, pinned), routed `standard` (reverse-spec, ran on Codex). Budget $2 per run; billed cost was $0 throughout.

## Traceable specs: met

`navarch run --flow reverse-spec` (run `brisk-hulk`) on the ctk CLI and the relay/handoff mechanism: 2 components, 17 claims, 16 🟢, 0 🟡, 1 🔴, **94 % 🟢** against the ≥ 70 % target. Hand check of the cited lines in `cli.py` (194–196, 435–438) matched. Finding F1: a claim keeps 🟢 when one of its citations is "not found" while others verify (`dispatches-subcommands`, `cli.py:229`); `verifyDrafts` should lower it or drop the bad citation. Sample is one run and two components: small.

## Context token reduction: not met

Six `task` runs, same three small edit prompts, `claude-code`, context off then on (`knowledge.context.enabled`). Every run ended `failed` at verify (`make test` exits 2 in the repository, unrelated to the edits), so each had 3 attempts. Median input tokens per attempt (`navarch metrics`): **161.4k with the block, 148.4k without, +9 %** against the −30 % target; block of about 2.4k tokens; success 100 % on both sides. PR acceptance not measurable (no PRs).

Reading: on tasks this small the agent already finds the code in a few reads, and the block adds tokens instead of saving them. The campaign did not cover larger tasks.

## Verdict

Specs criterion met. Token criterion not met on this sample, so `knowledge.context.enabled` stays `false`. Next: rerun on larger tasks in a repository without a failing baseline, and fix F1, before deciding whether to drop the context block.
