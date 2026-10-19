# 0070 — Lean context: point, do not explain

- Status: accepted; measured on 2026-10-19 and not met, so the default stays off ([report](../reports/2026-10-19-lean-context-campaign.md))
- Date: 2026-10-19
- Builds on: ADR 0043 (context compiler), ADR 0044 (context token metrics)

## Context

The Phase 3 campaign found the full context block raised median input tokens by 9 % instead of cutting them by 30 %, on small tasks in a small repository, where the agent already finds the code in a few reads. Public work agrees with the direction: a study of repository-level context files (ETH Zurich, arXiv 2602.11988) found they tended to lower task success and raise cost by over 20 %, because agents follow them into broader exploration; and Aider's repository map, the best-known ranked map, targets a model that cannot read files itself.

## Decision

1. **A lean mode.** Only the files most likely involved (symbol matches ranked by term strength, plus the test beside each), no excerpts: an agent reads a file whole before editing, so an excerpt is tokens spent twice. It stays under 600 tokens.
2. **Where it applies is configurable.** `profiles` and `min_complexity` let a campaign keep the block away from the triager and from small tasks, where its overhead dominates.
3. **No change of default.** `enabled` stays `false` and `mode` stays `full`. The criterion of ADR 0044 decides, on a larger repository and larger tasks than the first campaign used.

## Consequences

- 🟡 Whether this reduces tokens is unknown; the evidence above suggests it may not. If the measurement misses the target again, the code stays as an option and the feature stays off.
- 🟡 The ranking is line-based symbol matching, so tasks that name no identifier get no block.

## Outcome

The campaign of 2026-10-19 (3 pairs of medium tasks in the Navarch repository) found no saving: +1 %, +4 % and +13 % input tokens with the lean block. The code stays as an option; `enabled` stays `false`.
