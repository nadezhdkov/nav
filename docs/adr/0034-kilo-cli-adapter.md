# 0034 — Kilo CLI adapter for Kilo's free models

- Status: accepted
- Date: 2026-10-16
- Spec: §6.3.2 (agent adapters), §6.4 (catalog), §7 (tool grants)
- Builds on: ADR 0015 (OpenCode CLI adapter), ADR 0014 (free models), ADR 0004 (one account per provider)

## Context

The operator wants more agents that cost nothing. The candidates checked on 2026-10-16:

- **Qwen Code.** Its free Qwen OAuth tier was discontinued on 2026-04-15, according to its authentication docs. What is left is ModelStudio (paid), OpenRouter, DeepSeek or a local model, and the `native` adapter already covers the free ones among these. It would add no free quota.
- **Aider.** It needs your own key only, so it adds no free quota either.
- **Kilo CLI** (7.8.12, a fork of OpenCode). Kilo's gateway serves free models to the CLI without an account: `kilo/kilo-auto/free`, where the gateway picks a free model per request, plus about a dozen ids ending in `:free` (`kilo models kilo`).

## Decision

- **New `kilo` adapter** (`packages/adapters/kilo`) running `kilo run --format json --pure [--model kilo/<id>] [--session <id> | --title …] -- <prompt>` in the worktree. Kilo emits OpenCode's JSON events and takes OpenCode's permission rules, so `KiloAdapter` extends `OpencodeAdapter`. It overrides only the arguments, the environment and the CLI name. The OpenCode parser also learned Kilo's wording:
  - Denials: "a rule which prevents you from using this specific tool call", and "tried to call unavailable tool" for a tool the rules removed.
  - Errors: `error.name` with `error.data.message`, and `statusCode`.
- **The grant becomes the same permission rules as ADR 0015**, in `KILO_CONFIG_CONTENT`. Never `--auto`: without it, Kilo refuses anything the rules do not allow.
- **Navarch's configuration only:**
  - Kilo always reads its global config from `$XDG_CONFIG_HOME/kilo`, so the adapter points `XDG_CONFIG_HOME` (and `KILO_CONFIG_DIR`) at an empty directory for each attempt.
  - `KILO_DISABLE_PROJECT_CONFIG=1`.
  - `KILO_DISABLE_CLAUDE_CODE=1`, because Kilo would otherwise read `~/.claude`'s CLAUDE.md and skills.
  - `KILO_DISABLE_EXTERNAL_SKILLS=1`.
  - `--pure`, so no external plugins load.
  - `KILO_CONFIG`, `KILO_PROVIDER` and `KILO_TUI_CONFIG` are removed, and auto-update is off.
  - The data directory (sessions, a sign-in if the operator ever adds one) is left alone, so resume works.
- **Sessions:** the id from the first `step_start` is the resume token. A resume that fails with `Session not found` starts a new session.
- **Command:** without `adapters.kilo.command`, the adapter uses `kilo` from PATH, else `~/.kilo/bin/kilo`, where the installer puts it. This differs from ADR 0015, which refused such a fallback because it could bypass the test stubs. Here PATH is checked first, so the stub `kilo` that `test/no-real-agents.ts` puts first on PATH always wins, and an adapter test asserts it. `unavailableReason` reports a missing CLI, so the router skips it instead of failing a task.
- **Catalog, not tiers:** the built-in entry `kilo` (`kilo/kilo-auto/free`, provider `kilo`) is in the catalog, and `adapters.kilo.model` defaults to it for runs pinned with `--adapter kilo`, since Kilo's own default may be a paid model. It is in **no routing tier by default**:
  - Kilo's docs say Auto Free may route to providers that log prompts and outputs and use them.
  - Which provider serves a request is decided per request and is not visible beforehand.
  - Sending every triage of every repository there should be the operator's choice, made by adding `kilo` to a tier (`docs/examples/free-models.yaml` shows it).
- **Billing `metered`**, like OpenCode: free models report `cost: 0`, and paid Kilo models used with credits count against budgets. Kilo has no spending cap, so the ADR 0030 stop after the step that crosses the task's cap applies, inherited from `OpencodeAdapter`.

## Evidence (real runs, Kilo CLI 7.8.12, `kilo/kilo-auto/free`, no account, 2026-10-16)

- A run with no credentials answered (served by `dots-studio/dots-3-note-preview:free`, `cost: 0`). `step_finish` names the model that served the request.
- Only `ls` / `ls *` were allowed and `edit` was denied:
  - `ls > list.txt`, `cat a.txt`, `printf x > b.txt` and `python3 -c "open(...)"` were refused by a rule.
  - `write` was not offered to the model at all ("unavailable tool").
  - `ls -la` ran.
- Through `KiloAdapter`, with `ls` and `cat *` allowed and `~/.ssh` denied:
  - `ls && touch pwned.txt` was denied, which shows chains are checked per command.
  - A write to a path outside the worktree was denied (`external_directory`).
  - `cat ~/.ssh/known_hosts` was denied.
  - No file appeared.
- Through `KiloAdapter`, the implementer fixed a one-line bug in a scratch repository and ran `ls`, for $0.
- `--session <id>` resumed: the model recalled the file it had read. `--session ses_doesnotexist123` exited 1 with `Error: Session not found` on stderr.
- An unknown model gives two `error` events (`UnknownError`, the second one with "Model not found"); the adapter keeps the last one.

## Consequences

- A second free agent family beside OpenCode Zen and Grok's free tier, with no account and no key.
- 🟡 Kilo's free-tier rate limits have not been seen yet. The fake's 429 shape is assumed from OpenCode's, so a rate limit's wording may need a parser update. As for every CLI adapter, a rate limit marks the whole `kilo` adapter as exhausted, not one model.
- 🟡 With `kilo-auto/free`, the model behind an entry changes from request to request, so success rates and cost medians per catalog entry mix models.
- 🟡 Commands that an allowlisted program runs with an outside path as an argument are not blocked by `external_directory` (same caveat as ADR 0015). The deny-path rule covers the paths the grant names.
- Prompts sent to free models may be logged or used for training (ADR 0014). This is why `kilo` is in no tier until the operator puts it there.
