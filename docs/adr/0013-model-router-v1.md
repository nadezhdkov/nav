# 0013 — Model Router v1: catalog of adapter + model pairs, tier preference lists, routing at dispatch

- Status: accepted
- Date: 2026-10-14
- Spec: §6.3.3 (profile model requirements), §6.4 (Model Router and catalog), §9.2 (`model.routed`), §16 Phase 1
- Builds on: ADR 0004 (adapters), ADR 0005 (quota-aware retries), ADR 0011 (Flow engine), ADR 0012 (Copilot adapter)

## Context

Every agent of a run used the run's adapter. Phase 1 asks for a Model Router with a catalog and fallback, and §6.3.3 wants the reviewer on a different provider from the implementer. The operator's capacity is a mix of plans with quotas (Claude Code, Copilot with a monthly allowance of premium requests, Codex, Gemini) rather than per-token APIs, so the §6.4.2 score function (`quality − λ·cost − μ·latency`) has no cost or quality data to work with yet.

## Decision

- **Catalog entries are adapter + model pairs.** Navarch's CLI adapters are whole agents, so the router chooses an agent and, optionally, its model. Entries (`routing.models` in the config) have `adapter`, `model?`, `provider` and `status`; no prices or quotas in code.
- **Tiers are ordered preference lists** (`routing.tiers.fast|standard|expert`) instead of a score. Profiles map to tiers (`routing.profiles`, defaults from §6.3.3). Planner and implementer drop to `fast` when the triage's `Complexity: N` is at most `simple_max_complexity` (2); the implementer moves one tier up from the second fix-loop iteration (§6.4.2 step 6). Defaults: `fast` = Copilot then Claude Code, `standard`/`expert` = Claude Code then Copilot.
- **Filters:** entry active, adapter enabled, adapter not exhausted per its latest `quota.observed` windows. Profiles in `routing.different_provider` (default `reviewer`) take the first usable candidate whose provider the run's implementer did not use; when none is usable, the first usable one, and the reason says so rather than blocking the run.
- **Routing at dispatch, through the Agent Runtime.** The Scheduler asks `AgentRuntime.route()`, which calls the pure `packages/model-router` (rule 4: only the Agent Runtime calls the Model Router). It happens before the Policy Engine's decision so approvals name the chosen agent, and once per task; a `model.routed` event sets the task's adapter and model and drops its resume token.
- **Fallback on rate limits (§6.4.2 step 5):** a routed task that comes back `rate_limited` is routed again, excluding every entry it already left, and requeued at once as a quota wait (not an attempt). Without an alternative, ADR 0005's wait or pause applies.
- **Overrides (step 7):** `--adapter`/`--model` (API `adapter`/`model`) pin the whole run; a Flow node's `adapter` pins the node; `routing.enabled: false` pins every new run to `default_adapter`. Runs created before this ADR have no `routing` and are pinned.
- **Tests never reach a real agent.** A Vitest setup file puts stubs named after every agent CLI first on PATH and removes provider keys. While this slice was being built, a test daemon routed to the real `copilot` and started 10 sessions on the operator's plan; the stubs make that impossible.

## Consequences

- With the defaults, an issue run spends Copilot premium requests on triage and, for simple issues, on planning and implementation; Claude Code handles the rest and reviews Copilot's work. When Copilot's monthly allowance is exhausted (ADR 0012's quota event), it is skipped until the 1st.
- Decisions are explainable: each `model.routed` carries the tier, the reason, the candidates and why others were skipped.
- Not yet: the budget filter (step 3), `observed` metrics and a score; Copilot reports only exhaustion, not remaining requests. A fallback agent starts a new conversation in the same worktree.
