# 0024 — Grok CLI adapter, with a guard hook for exact enforcement

- Status: accepted
- Date: 2026-10-15
- Spec: §6.3.2 (agent adapters), §6.4 (catalog), §7 (tool grants)
- Builds on: ADR 0004 (multiple adapters), ADR 0006 (Navarch's configuration, per-task homes), ADR 0013 (Model Router v1), ADR 0015 (OpenCode adapter, same shape), ADR 0023 (billing)

## Context

The operator has the Grok CLI (`grok`, "Grok Build", 1.0.52) signed in with a grok.com account on its free tier, which serves `grok-4.7`. It is a strong agent at no cost per call, a good fit for the `fast` tier (triage, issues of complexity ≤ 2) next to Copilot, whose prompts each cost a premium request.

Headless mode (`grok -p`/`--prompt-file`, `--output-format streaming-messages-json`) prints the Anthropic Messages wire format, close to Claude Code's stream-json: an `init` line with `session_id` and `apiKeySource`, `assistant` and `user` messages with tool calls and results, and a `result` line with `modelUsage` and an API-equivalent `total_cost_usd`. Sessions are created with `--session-id <uuid>` and resumed with `--resume <id>`.

Two things needed care:

1. **Grok loads the operator's setup.** Besides `~/.grok` (config, memory, hooks, plugins), it reads Claude Code's files: `~/.claude/skills`, `~/.claude/plugins`, MCP servers from `~/.claude.json`, permission rules and hooks from `~/.claude/settings.json`. On the first probe, the task saw all of the operator's skills and an MCP server.
2. **Grok's rules do not enforce an allowlist exactly.** `--permission-mode dontAsk` on the command line did not deny unlisted shell commands. `defaultMode: "dontAsk"` in `.claude/settings.json` (what Grok's docs recommend for deny-by-default in headless runs) denied `cp`, `python3 -c`, `git commit` and `node --version`. But it still ran `touch` and `mkdir` in the workspace, even for a task with no edit rights. An edit refused in `--permission-mode dontAsk` cancelled the whole run (`stop_reason: cancelled`) instead of being reported to the model.

## Decision

- **New `grok` adapter** (`packages/adapters/grok`) running `grok --prompt-file <file> --output-format streaming-messages-json --session-id <uuid> | --resume <id> [--model] [--max-turns] --no-subagents --disallowed-tools … [--disable-web-search]` in the worktree. The prompt goes in a file in the task home, so long issue bodies are not limited by argument size. A resume that fails because Grok no longer has the session ("not found … 404 Not Found") starts a new session.
- **A home per task**, `~/.navarch/agents/grok/<run>-<task>`, used as both `HOME` and `GROK_HOME`. Only the login is shared: `auth.json` (and its lock, so two tasks refreshing at once take turns) are symlinks to the operator's `~/.grok`. A forced token refresh (`GROK_AUTH_EARLY_INVALIDATION_SECS`) wrote the new token through the link into `~/.grok/auth.json`, so the operator stays signed in. The home's `config.toml` turns off auto-update, `.envrc` loading, telemetry and feedback; the environment sets `GROK_MEMORY=0` and `GROK_SUBAGENTS=0` and removes `GROK_FOLDER_TRUST` and `GROK_AGENT`. Project hooks, MCP servers and skills stay behind Grok's folder trust, which a task never grants. As for gemini-cli (ADR 0006), the home is kept after a failure so a retry can resume, and removed after success or cancel.
- **The grant is enforced twice:**
  1. Grok's rules, as `permissions` in the home's `.claude/settings.json`: `defaultMode: dontAsk`; allow `Edit`/`Write` when the grant edits, and `Bash(<prefix>)` (plus `Bash(<prefix> *)` for wildcards) per allowed command; deny the deny prefixes, `Read|Edit|Write|Grep(<path>/**)` for each denied path with `~` spelled as the operator's real home (since `HOME` is the task's), `WebFetch` without network, and `Edit`/`Write` for read-only tasks. Tools a task never gets are removed: edit tools for read-only tasks, web tools without network, media generation, `send_feedback`, `ask_user_question`, `monitor`, `workflow`, and sub-agents.
  2. **Navarch's guard**, a global `PreToolUse` hook in the task's `GROK_HOME/hooks` (global hooks need no folder trust): `node guard-hook.ts <policy.json>`, with the grant and the worktree path. Every shell command is split on `&&`, `||`, `;`, `|` and newlines, and each segment must be an allowlisted command (kit `commandAllowed`) or a fixed read-only command (`ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `git status|diff|log|show`) without options that write or run programs (`--output`, `--ext-diff`, `--pre`, `--textconv`). Substitutions, redirections and escapes (`` ` $ < > ( ) { } \ ``) and denied paths are refused. File edits must stay inside the worktree, and reads must stay out of denied paths. A deny is JSON on stdout plus exit 2. A guard that cannot read its policy denies.

  Enforcement is `exact`. Grok runs hooks fail-open (a crash or a timeout lets the call through), so the rules stay as the layer underneath; the hook timeout is 30 s.
- **Billing:** `plan` when `apiKeySource` is `oauth` (grok.com sign-in), `metered` otherwise (an `XAI_API_KEY`). Grok's API-equivalent cost becomes `plan_cost` (ADR 0023).
- **Routing:** a built-in catalog entry `grok` (provider `xai`) heads the default `fast` tier: `grok, copilot, claude-code`. `unavailableReason` skips it while there is neither an `auth.json` in the operator's Grok home nor an `XAI_API_KEY`, so a machine without Grok routes as before. Tests point `GROK_HOME` at an empty directory and stub `grok` on PATH.

## Evidence (real runs, Grok CLI 1.0.52, `grok-4.7`, 2026-10-15)

Through the adapter, in a scratch repository:

- Read-only grant with only `node --version` allowed: `touch t.txt`, `mkdir d2`, `ls && touch u.txt`, `read_file` and `cat` of a denied path were refused by the guard; `node --version` and `git status` ran; nothing was written.
- Implementer grant: the edit inside the worktree went through; `write` to a file outside the worktree, `python3 -c …` and `printf … > outside.txt` were refused. The model read the guard's reasons and adjusted (ran `node --version` alone after a chain was refused).
- `init` reported `apiKeySource: "oauth"`; the `result` line reported `modelUsage` with `costUSD` ≈ $0.03–0.05 per small task, recorded as `plan`.
- Through `navarchd` (`navarch run --adapter grok`, `task` flow, a Node project with `npm test` allowlisted and as the verify check): Grok read the files, ran `npm test`, fixed the bug and ran it again; the run was `done` in 19 s, and `navarch usage` showed $0.00 billed and $0.0551 plan-equivalent. The task's home was removed afterwards.
- With the per-task home, `init` listed none of the operator's skills or MCP servers. `--resume` with a prompt file recalled the earlier session; a missing session failed with a 404 and starts a new one.

## Consequences

- Grok's free tier can carry triage and simple issues before Copilot's premium requests are spent.
- 🟡 The free tier's limits and the shape of its rate-limit answer have not been seen yet. A rate limit is classified from the result's `errors` text and stderr (kit `classifyError`), with the reset time if the text gives one, else the ADR 0005 backoff, and the router falls back to the next candidate at once.
- 🟡 With `HOME` set to the task home, commands an agent runs do not see the operator's dotfiles (`~/.gitconfig`, `~/.npmrc`, tool caches under `~`). That is intended (no credentials leak to the agent), but a project whose checks need such a file should prepare it with `--setup` or the project's `setup` commands, which Navarch runs outside the agent.
- 🟡 The read-only list in the guard is Navarch's own and shorter than Grok's; an agent that wants other read-only commands needs them allowlisted.
- Free-tier prompts may be used by xAI under its terms (see its data retention settings).
