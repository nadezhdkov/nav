# Phase 1, slice 3: Model Router v1

Status: implemented · Branch: `feat/model-router` · Spec: §6.3.3, §6.4, §9.2 · ADR: 0013

Agents of a run no longer all use one adapter. The Model Router picks, for each agent task, a catalog entry (an adapter plus an optional model) from the task's tier, what the run knows so far and which quotas are exhausted.

## Behavior

```
navarch run --issue owner/repo#42                 # routed: triage on Copilot, simple issue on Copilot, review on Claude
navarch run --adapter claude-code "…"             # pinned: every agent on Claude Code, no routing
navarch run --model ollama/qwen2.5:7b --adapter native "…"   # pinned
```

Default `routing` (in `~/.navarch/config.yaml`):

| Profile | Tier | Tier candidates (in order) |
|---|---|---|
| `triager` | fast | copilot, claude-code |
| `planner` | expert (fast when triage complexity ≤ 2) | expert: claude-code, copilot |
| `implementer` | standard (fast when complexity ≤ 2; one tier up from the 2nd fix iteration) | standard: claude-code, copilot |
| `reviewer` | standard, on a provider other than the implementer's | standard: claude-code, copilot |

The catalog (`routing.models`) maps ids to `{ adapter, model?, provider, status }`; the defaults cover the five CLI adapters. A `native` entry with a model (e.g. a free OpenRouter model) can be added and put in any tier.

## Rules

- A run is `auto` unless the request has `adapter` or `model`, or `routing.enabled` is false; then it is `pinned` and behaves as before. Runs from before routing are pinned. A Flow node with its own `adapter` is pinned.
- Routing happens at dispatch, before the Policy Engine, so an approval names the chosen agent. The Scheduler asks the Agent Runtime, the only caller of the router (rule 4).
- Candidates are skipped when the entry is disabled or missing, the adapter is not enabled, or the adapter's latest `quota.observed` for some window is exhausted with a reset in the future.
- The triager ends its summary with `Complexity: N`; the Scheduler stores it as `outputs.complexity` of the triage task.
- `model.routed` records the choice: catalog id, adapter, model, provider, tier, reason, candidates, skipped ones with why, and `fallback_from` on a fallback. It sets the task's adapter and model and drops its resume token.
- A rate-limited routed task asks the router again, excluding every entry it already left. If another entry is usable it is requeued at once with `not_before` = now, counted as a quota wait, not an attempt; otherwise the ADR 0005 wait or pause applies.
- No usable candidate: the task keeps the run's adapter (the daemon's `default_adapter`), which then waits for its quota, and the reason says so.

## Tests (no network, no real agent)

- `packages/model-router`: profile tiers, the complexity shortcut, escalation, skip reasons, no candidate, reviewer on another provider and its fallback, catalog models.
- Daemon end to end with fake Claude and fake Copilot: a simple issue (triage, plan and implement on Copilot, review on Claude, PR opened, decisions and reasons); a rate limit on Claude falling back to Copilot at once without passing Claude's session; `--adapter` pinning a run.
- `test/no-real-agents.ts` (Vitest setup) puts failing stubs named `claude`, `gemini`, `agy`, `codex`, `copilot`, `opencode` and `ollama` first on PATH and removes provider API keys.

## 🔴 Open

- Budget filter (§6.4.2 step 3) and `observed` metrics (latency, error rate, success by profile) are not implemented.
- The order within a tier is a preference list, not a cost/quality score.
- Copilot only reports exhaustion, not remaining premium requests, so "while quota lasts" means until the first refusal.
- A fallback agent continues in the same worktree with whatever the previous agent left, from a fresh conversation.
