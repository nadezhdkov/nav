# 0014 — Free models through the native adapter: Vault keys, OpenCode Zen, scoped daily limits

- Status: accepted; the OpenCode Zen part is superseded by ADR 0015
- Date: 2026-10-14
- Spec: §6.3.2 (`native`), §6.4 (catalog, fallback), §6.1.5 (Vault), architecture rule 7
- Builds on: ADR 0004 (native adapter), ADR 0007 (Vault), ADR 0013 (Model Router)

## Context

The user wants free capacity for basic work. Two services offer free models with tool calling behind OpenAI-compatible APIs: OpenRouter (ids ending in `:free`; 20 requests/min and 50/day, 1,000/day after buying 10 credits once) and OpenCode Zen (`-free` ids and `big-pickle`; limits not published, offers often time-limited). The native adapter already speaks that API, but read provider keys only from environment variables and treated every 429 alike. An agentic task makes 20–60 model calls, so a free daily limit runs out after one or two tasks, and the router has to notice.

The user's machine (Radeon RX 580 8 GB, 15 GB RAM) runs 7B local models, which made wrong tool calls in Phase 0 (ADR 0004); local models stay out of agent work for now.

## Decision

- **No new adapter.** *(Superseded for OpenCode Zen by ADR 0015: the Zen API refuses free models to any client but OpenCode, so they run on an `opencode` CLI adapter. OpenRouter stays as decided here.)* Free models are catalog entries on the `native` adapter (`openrouter/<id>:free`, `opencode-zen/<id>`). A separate `opencode` CLI adapter would add a second tool loop and permission system for the same models.
- **Provider keys from the Vault:** a native provider may name `api_key: secret://…` (stored with `navarch secret set`), read when a task starts and registered for redaction; `api_key_env` still wins when set. A key written literally in the config is refused by the schema. Defaults: `openrouter` → `secret://openrouter/api_key`, new provider `opencode-zen` (`https://opencode.ai/inference/v1`) → `secret://opencode/api_key`.
- **Availability:** `AgentAdapter.unavailableReason(model)` (optional, synchronous). The native adapter answers from a cached key check (refreshed in the background after 60 s, and at every task start), so the router skips a free entry whose provider has no key instead of failing the task.
- **Scoped daily limits:** a 429 carrying `X-RateLimit-Reset` (response header, or OpenRouter's `error.metadata.headers`) becomes `retry_at` plus a `quota.observed` with `model_prefix` = `<provider>/` and the limit's name (`free-models-per-day`). The router skips only that provider's models until the reset; other native providers stay usable. The fallback of ADR 0013 moves the task on at once.
- **Catalog ids stay in configuration.** `routing.models` from the config is added to the built-in entries (one per CLI adapter) instead of replacing them. `docs/examples/free-models.yaml` lists suggested free entries and a `fast` tier that tries them first, with the data-use caveats; the defaults do not include free models.
- **Tests never read the keychain:** the Vitest setup also stubs `secret-tool`. Doing so exposed an unhandled `EPIPE` in the Vault when `secret-tool` exits before reading stdin; the Vault now ignores it, as the adapter kit does.

## Consequences

- With keys stored and the example merged, triage and simple issues run on free models first, then Copilot and Claude Code; a failed verification still escalates the implementer to `standard`.
- 🟡 OpenRouter's daily-limit body shape is taken from its documentation and covered by a fake; not yet seen live. Zen's 429s carry no known reset, so they use the ADR 0005 backoff and the immediate fallback.
- Free models' prompts may be logged or used for training (per-model terms). Keep them out of the tiers for private or confidential repositories; per-project routing policy (§6.4.2 step 2) is still to come.
- Which free model goes first is a guess until a comparison on real issues; `docs/examples/free-models.yaml` should be updated with its results.
