# 0015 — OpenCode CLI adapter for OpenCode Zen's free models

- Status: accepted
- Date: 2026-10-14
- Spec: §6.3.2 (agent adapters), §6.4 (catalog), §7 (tool grants)
- Supersedes: the OpenCode Zen part of ADR 0014 ("No new adapter")
- Builds on: ADR 0004 (multiple adapters), ADR 0012 (Copilot CLI adapter, same shape)

## Context

ADR 0014 put OpenCode Zen's free models on the `native` adapter, calling `https://opencode.ai/inference/v1` with a key from the Vault. A real call refuted that: the API answers free models with `403 FreeTierError: "OpenCode's free tier can only be used from within OpenCode."`. Getting a key also requires billing details in the OpenCode console. The free tier is meant for the OpenCode client, so the only legitimate way to use it from Navarch is to drive that client. Imitating the client's requests from the native adapter would get around the provider's terms, and we do not do that.

The operator is logged in to the OpenCode CLI (2.0.29) with a Google account; no key is involved.

## Decision

- **New `opencode` adapter** (`packages/adapters/opencode`) running `opencode run --standalone --format json [--model opencode/<id>] [--session <id>] -- <prompt>` in the worktree, like the Copilot adapter (ADR 0012). Catalog entries use `adapter: opencode`; `docs/examples/free-models.yaml` moves its Zen entries there.
- **The grant becomes OpenCode permission rules**, passed in `OPENCODE_CONFIG_CONTENT`: `"*": deny`, `read`/`glob`/`grep`/`lsp` allowed, `edit` per grant, `webfetch`/`websearch` per `network`, `external_directory` and `doom_loop` denied, and `bash` = deny everything, allow each allowlisted command (`npm run *` → `npm run` and `npm run *`), then deny the deny prefixes, redirections (`*>*`, `*<*`) and command lines naming a denied path. OpenCode applies the last matching rule, so denials come last. Enforcement is `exact`.
- **Navarch's configuration only:** an empty per-attempt `OPENCODE_CONFIG_DIR`, `OPENCODE_DISABLE_PROJECT_CONFIG=1` (a repository's `opencode.json` could loosen permissions or add MCP servers), `OPENCODE_CONFIG` removed, auto-update off. `--standalone` gives each task a private server, so the environment applies to it rather than to the operator's background service. Never `--auto`.
- **Sessions:** OpenCode names the session; a session id Navarch makes up is refused (the same `FreeTierError`). The id from the first `step_start` event becomes the resume token; a resume that fails as a missing or refused session starts a new one.
- **Not on PATH by default:** the installer puts the CLI in `~/.opencode/bin`. The default command stays `opencode`, and the operator sets `adapters.opencode.command` when needed. Navarch does not look in `~/.opencode/bin` itself: the test setup stubs agent commands on PATH, and an absolute fallback would bypass that stub and reach the real CLI.
- The native provider `opencode-zen` stays for paid Zen models with a key; it does not serve free models.

## Evidence (real runs, `opencode/big-pickle`, 2026-10-14)

- With only `ls` / `ls *` allowed: `ls && touch x`, `ls; touch x`, `ls | tee x` and `ls $(touch x)` were denied (`Permission denied: shell`). `ls > x` ran and wrote a file until `*>*` was added; then `>`, `>>` and `2>` were all denied.
- `write` to a path outside the worktree was denied (`Permission denied: external_directory`).
- `--session <id from step_start>` resumed the conversation (the model recalled a word from the first run); `--session ses_navarchprobe0001` failed with `FreeTierError`.
- Free models report `cost: 0` and token counts per `step_finish`.

## Incident: inherited PWD (2026-10-14, bake-off)

The first bake-off runs on this adapter worked in the daemon's directory (the `free-models` development worktree) instead of their task worktrees: OpenCode takes its project directory from `$PWD`, not from the process cwd, and the adapter kit passed the daemon's `PWD` through. A `big-pickle` implementer committed three commits of new files there (nothing modified, nothing pushed; they were removed and kept as patches). The permission rules held: `external_directory` is relative to that wrong project, which is why the edits were allowed. Confirmed with a probe (cwd `pa`, `PWD=pb` → session recorded in `pb`). Fix: `CliProcesses` sets `PWD` to the task's cwd for every CLI adapter, with a kit test and an adapter assertion.

## Consequences

- Zen's free models are usable with the operator's OpenCode login and no key.
- 🟡 Commands that an allowlisted program runs with an outside path as an argument (`ls /elsewhere`) are not blocked by `external_directory`; only writes through OpenCode's tools are. The deny-path rule covers the paths the grant names (`~/.ssh`).
- 🟡 Zen's free-tier rate-limit responses have not been seen yet. A rate limit marks the whole `opencode` adapter as exhausted until the reset or the ADR 0005 backoff, not one model.
- Free models' prompts may be logged or used for training (ADR 0014 caveat applies).
