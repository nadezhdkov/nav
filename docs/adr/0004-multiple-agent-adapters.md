# 0004 — Gemini CLI, Antigravity, Codex and native adapters before Phase 1, with a neutral tool grant

- Status: accepted
- Date: 2026-10-14
- Spec: §6.3.2, §6.4, §16 (Phase 4 adapters brought forward), §1.4

## Context

Phase 0 shipped only the `claude-code` adapter. The user wants to use free or cheap capacity: the Gemini CLI free tier, Codex (included in ChatGPT plans, including the free one), local models through Ollama, and free models on OpenRouter. The spec placed the Codex and Gemini adapters in Phase 4 and the `native` adapter in Phase 1.

## Decision

- **Adapters now:** `gemini-cli`, `antigravity`, `codex` and `native` ship next to `claude-code`, chosen per run with `adapter` (CLI `--adapter`), with `default_adapter` in the config. Each adapter can be disabled in `~/.vectr/config.yaml`.
- **Shared kit:** `packages/adapters/kit` holds subprocess handling, environment scrubbing, error classification, command matching and outcome mapping, used by the four CLI adapters.
- **Neutral grant:** `ToolGrant` no longer uses Claude Code rule syntax. It is `{ editFiles, allowCommands, denyCommands, denyPaths, network }`, and each adapter translates it:

  | Adapter | Mechanism | Enforcement |
  |---|---|---|
  | `claude-code` | `--allowedTools` / `--disallowedTools` rules | exact |
  | `gemini-cli` | generated policy file passed with `--policy` (TOML rules) | exact |
  | `antigravity` | generated `settings.json` (`permissions.allow/deny`, `command(regex:…)` rules) in a per-task `HOME` | exact (see below) |
  | `codex` | OS sandbox: `sandbox_mode="workspace-write"`, network off, `approval_policy="never"` | sandbox |
  | `native` | VECTR runs every tool call itself | exact |

  Codex in exec mode has no per-command allowlist, so its commands are confined by the sandbox instead of filtered one by one. `AdapterCapabilities.enforcement` records this.
- **Native adapter:** an agent loop over any OpenAI-compatible `/chat/completions` endpoint. Model ids are `<provider>/<model>`. Providers come from the config, with `ollama` and `openrouter` built in. Its tools (`list_files`, `read_file`, `search`, `write_file`, `edit_file`, `run_command`) resolve paths inside the worktree (symlinks included), keep `.git` read-only, and run allowlisted commands without a shell. It is not resumable: a retry starts a new conversation in the same worktree.
- **Antigravity adapter:** runs `agy --print … --output-format stream-json --mode accept-edits` (or `plan` without edits). agy reads permission rules only from its user settings, and a per-project file was not honored in headless mode, so each task gets its own `HOME` under `~/.vectr/agents/antigravity/<run>-<task>` with a generated `settings.json`. The Google login sits in the system keyring and still works there; `GIT_CONFIG_GLOBAL` points git back at the user's config. Wildcard allow rules exclude shell metacharacters, so chained commands are denied. In headless mode a denied tool ends the agent's turn, and agy still reports `SUCCESS`; the adapter emits a `denied` event and continues the same conversation with a message naming the denied action and the allowed commands, up to 5 times, then fails the task. The home is kept after a failure (for resume) and removed after success or cancel.
- **Resume:** Antigravity uses `--conversation <id>` with the `conversation_id` from `init`, after checking that the conversation file still exists in the task's home. Gemini uses `--session-id` / `--resume <uuid>`. Codex uses the `thread_id` from `thread.started` with `codex exec resume <id>`. Both fall back to a new session when the old one is gone.
- **Accounts:** one account per provider, logged in through that provider's own CLI. VECTR does not rotate several accounts of the same service to add up quotas. That would break those services' terms and spec §1.4. To get more capacity, use different providers, local models, or paid API keys.

## Consequences

- Free capacity is usable today: the Gemini CLI free tier, Codex on a ChatGPT plan, and local models at no cost.
- Gemini, Antigravity and Codex report tokens but not cost, so their usage is recorded at cost 0, and run budgets do not limit them. Quota exhaustion is classified as `rate_limited` and retried.
- Small local models make wrong tool calls more often. A smoke run with `ollama/qwen2.5:7b` fixed one of two requested edits and still reported success. Verification (spec §6.6) is what catches this; until it exists, read the diff.
- Google no longer accepts the personal Google-account login in the Gemini CLI ("This client is no longer supported for Gemini Code Assist for individuals"). The `gemini-cli` adapter therefore needs `GEMINI_API_KEY` (AI Studio, e.g. in `~/.gemini/.env`) with `security.auth.selectedType: "gemini-api-key"`. Google account and subscription use goes through the `antigravity` adapter instead.
- Antigravity allow rules match a little more than VECTR's exact patterns: with `command(regex:^git status$)`, agy 1.3.5 still ran `git status --short`. Chained commands, denied prefixes and commands without a rule were denied as expected.
- agy reports usage cumulatively per conversation; the adapter records the difference between turns. An attempt that resumes a conversation from an earlier daemon process records the cumulative figure, so it can overcount tokens (cost stays 0).
- Real runs verified on 2026-10-14: `gemini-cli` 0.64.0 with `gemini-2.5-flash` (edit, denied command) and `antigravity` 1.3.5 with `gemini-3.8-flash-medium` (edit, denied command with continuation, resume after a daemon restart). The `codex` adapter has only been run against its fake CLI (codex-cli 0.162.1 event format) because the CLI is not logged in.
