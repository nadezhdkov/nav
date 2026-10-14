# Phase 0 go/no-go — 2026-10-14

**Criterion (spec §16, Phase 0):** run 10 real tasks on our own repositories, with logs and diff captured, resuming correctly after restarting the daemon in the middle of 2 of them.

**Verdict: met.** 10 tasks ran on three of our repositories with logs and diff artifacts captured; 3 were interrupted by a daemon restart and resumed the same agent conversation. Every result was checked by hand afterwards: 7 were acceptable as is, 3 needed a small fix, none was rejected.

## Setup

- Daemon from `main` at 6262390, its own `NAVARCH_HOME`, `scheduler.concurrency: 3`, `budgets.default_run: 5`.
- One Agent Brief per task (skill `agent-brief`) as the run prompt, with a per-repository `--allow` list for test and lint commands.
- Repositories: [claude-toolkit](https://github.com/nadezhdkov/claude-toolkit) (Python, ~360 tests), [game-asset-finder](https://github.com/nadezhdkov/game-asset-finder) (Python, single-file MCP server), and a fork of [REA](https://github.com/morluto/rea) (TypeScript, ~1800 source files, its own strict AGENTS.md).
- Restart test: `navarch daemon stop` while three tasks were running, `navarch daemon start` 15 s later.

## Results

| Task | Adapter | Outcome | Hand check |
|---|---|---|---|
| claude-toolkit: `>`/`<=` with partial versions in the npm range matcher | claude-code | accepted | `make check` ✓; the agent could not run checks itself |
| claude-toolkit: npm hyphen ranges | antigravity | accepted, resumed | 12/12 independent npm cases ✓ |
| claude-toolkit: `ctk runq` recognizes `node --test` | codex | small fix | tests ✓, lint ✗ (ambiguous `ℹ`, long line, format) |
| game-asset-finder: asset folder empty for non-ASCII titles | claude-code | accepted | lint, format, tests ✓ |
| game-asset-finder: tests for the HTTP helper (429, cache) | codex | accepted | 17 tests ✓ |
| game-asset-finder: `## None` heading in CREDITS.md | antigravity | accepted | ✓ (first try on gemini-cli failed, see F1) |
| game-asset-finder: no credit when no requested file exists | codex | small fix | ✓, but the result names paths that were not created |
| REA: tests for COFF machine decoding | antigravity | accepted, resumed | test, oxlint, oxfmt ✓ |
| REA: tests for code point ordering | codex | accepted | ✓ (first try on gemini-cli failed, see F1) |
| REA: literal digest-identifier prefix | claude-code | small fix, resumed | test, tsc, oxlint ✓; test file fails oxfmt |

The three claude-toolkit changes were finished and proposed upstream (nadezhdkov/claude-toolkit#43).

**Resume:** all three interrupted tasks went `running → interrupted → ready → running` on restart, kept their resume token (no new token was issued), and the claude-code task continued the same session id.

**Cost:** claude-code reported $1.66 for its three tasks (subscription-equivalent); codex, antigravity and gemini-cli report no cost.

## Findings

| # | Finding | Effect |
|---|---|---|
| F1 | gemini-cli uses the user's global auth choice; `oauth-personal` is rejected by Google (`IneligibleTierError`) | both gemini-cli runs failed in 7 s |
| F2 | `claude -p` loads the user's global `~/.claude` instructions and hooks | the agent reached for tools outside the run's allowlist (spec §10.2 T1) |
| F3 | the agent is not told the allowlist | near-miss denials (`uv run --frozen python -m pytest` vs `uv run pytest *`); most agents could not run their checks |
| F4 | the worktree is not prepared | no `node_modules`; codex's sandbox could not write the uv cache and had no network |
| F5 | `succeeded` means the agent stopped, not that the work is verified | two "succeeded" runs had failing lint or no checks run (closed by Phase 1 Verification) |
| F6 | after a restart, interrupted tasks are dispatched after never-started ones | resumed work waits behind new work |
| F7 | `navarch run list` prints multi-line prompts inside the table | unreadable list |

F1–F4, F6 and F7 are fixed before Phase 1; F5 belongs to Phase 1 Verification.
