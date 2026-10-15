# 0016 — Conversational CLI: a concierge agent in the Core with human-confirmed actions

- Status: accepted
- Date: 2026-10-15
- Spec: §6.12.4 (natural-language instruction), §6.14 (CLI), §9.1 (Core API), architecture rules 1, 3, 4
- Builds on: ADR 0004 (native adapter), ADR 0013 (Model Router), ADR 0014 (free models)

## Context

The operator wants to drive Navarch the way they drive Claude Code or OpenCode: open `navarch`, ask in plain language, have it act. The spec only lists subcommands (§6.14) and, for mobile, "send a natural-language instruction for a Run or new work" (§6.12.4). A model that can trigger runs, approvals and cancellations is a new path to side effects, and its context includes agent output and issue text, which are untrusted (T1).

## Decision

- **A concierge agent in the daemon.** `packages/concierge` holds the conversation loop and the engine interface; the daemon binds its tools to the same Core functions the REST API calls and exposes `/api/v1/concierge/…`. The CLI is a thin REPL (rule 1); the Web UI and PWA can reuse the API.
- **Engine first on the native client, MCP later.** `ConciergeEngine` takes messages and tool specs and returns text or tool calls. This slice implements it with the native adapter's OpenAI-compatible client and function calling, so API models (free OpenRouter, Ollama, a paid key) serve it and a turn takes seconds. Driving Claude Code or Copilot needs Navarch's tools as an MCP server; that is a later slice behind the same interface. Decided with the user.
- **Model selection through the Agent Runtime** (rule 4): `concierge.model` pins one; otherwise the runtime routes profile `concierge` (tier `fast`) among catalog entries on the `native` adapter, with the usual quota and key checks.
- **Read now, act on a human yes.** Read tools run during the turn. Act tools (`start_run`, `cancel_run`, `resume_run`, `approve`, `reject`) only create a single-use proposal and end the turn; the operator confirms through a separate API call, and the action then runs as the user through the existing orchestrator calls, so the Policy Engine (rule 3) and autonomy levels apply unchanged. The model has no way to confirm. Approving a Navarch approval through the concierge is still a human decision, made at the confirmation prompt.
- **Untrusted content is marked as data** in tool results; with confirmations, an injected instruction can at most produce a proposal the operator sees and can reject.
- **Events**: `concierge.message`, `concierge.action.proposed`, `concierge.action.decided`, with null `run_id` unless an action names a run. Conversation state stays in daemon memory for now.

## Consequences

- The conversational surface works with free or local models and costs nothing per message on them; on free tiers it shares their daily limits with agent tasks.
- Quality depends on the API model's function calling; small local models may pick the wrong tool, but a wrong act tool only yields a proposal to decline.
- Conversations are lost on daemon restart, and replies are not streamed; both can come with the Web UI.
- Spec §6.14 and §9.1 gain the `chat`/`ask` commands and the concierge routes (to be reflected when the spec is translated).
