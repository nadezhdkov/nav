# Phase 1, slice 4: conversational CLI (concierge)

Status: in progress · Branch: `feat/conversational-cli` · Spec: §6.12.4 ("natural-language instruction for a Run or new work"), §6.14, §9.1 · ADR: 0016

`navarch` with no arguments opens a conversation: the operator asks in plain language and a **concierge** agent answers from Navarch's state and proposes actions. Reading is immediate; anything that changes something waits for the operator's explicit yes. The existing subcommands stay for scripting.

## Behavior

```
$ navarch
navarch> what is running?
  2 runs: run_01… executing (implement on copilot), run_01… awaiting approval (open PR)
navarch> start a run here to add a CONTRIBUTING.md
  Proposed: start run in /home/me/repo, task flow, prompt "Add a CONTRIBUTING.md …"
  Confirm? [y/N] y
  run run_01… created (executing)
navarch> /exit

$ navarch ask "why did run_01… fail?"     # one turn; proposals are printed, never executed
$ navarch chat                            # same as bare navarch
```

REPL commands: `/help`, `/new` (fresh conversation), `/exit` (also Ctrl-D).

## Rules

- **Runs in the Core.** The conversation loop lives in the daemon (`packages/concierge`, wired in `apps/daemon/src/concierge`); the CLI only sends text and shows replies (architecture rule 1). The same API serves the Web UI and the PWA later.
- **Engine behind an interface** (`ConciergeEngine`): this slice ships an OpenAI-compatible chat engine on the native adapter's client (function calling). An MCP engine driving Claude Code or Copilot is a later slice.
- **Model**: `concierge.model` (`<provider>/<model>` of a native provider) pins it; otherwise the Agent Runtime routes profile `concierge` (tier `fast` by default) among `native` catalog entries only, skipping exhausted quotas and providers without a key. No usable model: the API answers 503 with how to configure one.
- **Tools** map one to one to Core functions the API already uses:
  - read (run at once): `list_runs`, `show_run`, `run_events` (last N), `list_approvals`;
  - act (proposal, needs confirmation): `start_run`, `cancel_run`, `resume_run`, `approve`, `reject`.
- **Confirmation is human-only.** An act tool call becomes a proposal (`concierge.action.proposed`) and the turn ends. Only `POST …/proposals/:id` with `approve` executes it, as the user (`actor: user`), through the same orchestrator calls and Policy Engine checks as the REST endpoints. A rejected or ignored proposal does nothing. The model cannot confirm, and a proposal is single-use.
- **Untrusted data**: tool results that carry agent output, logs or issue text are wrapped as data, not instructions (T1). They cannot act on their own, since every side effect needs the human's yes.
- **No secrets**: no tool reads or sets secrets or config.
- **Events**: `concierge.message` (role, text, model, usage), `concierge.action.proposed`, `concierge.action.decided`; `run_id` is null unless the action names a run. Conversations live in daemon memory; after a restart the CLI starts a new one.
- `start_run` defaults `repo_path` to the directory the CLI was started in.

## API

| Method | Route | |
|---|---|---|
| POST | `/api/v1/concierge/conversations` | `{ cwd? }` → `{ id }` |
| POST | `/api/v1/concierge/conversations/:id/messages` | `{ text }` → `{ reply, proposals[], model }` |
| POST | `/api/v1/concierge/conversations/:id/proposals/:pid` | `{ decision: approve \| reject }` → `{ result, reply }` |

## Tests (no network, no real agent)

- `packages/concierge`: the loop with a scripted engine: read tools run and feed results back; act tools stop the turn with a proposal; approve runs the action once and continues; reject and reuse; turn limit; untrusted wrapping.
- Daemon end to end with the native fake model server and the fake Claude CLI: ask what is running, propose a run, approve it, the run starts; rejecting starts nothing; no native model → 503.
- CLI: the REPL against a stub API (confirmation prompt, `/new`, `/exit`).

## 🔴 Open

- MCP engine for Claude Code / Copilot (ADR 0016).
- `POST /api/v1/runs/:id/messages` (instructions to a running run, §9.1) is not part of this slice.
- Conversations are not persisted across daemon restarts; replies are not streamed token by token.
