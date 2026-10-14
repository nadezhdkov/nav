# VECTR

*Verified Engineering Coordination for Tasks and Repos*: a local-first coordination layer that runs coding agents (Claude Code, Gemini CLI, Codex, or local and remote models through its own agent loop) in isolated git worktrees, records everything as events, and lets you follow and control the work from a CLI (Web UI and mobile come later).

Status: **Phase 0** plus multiple adapters. Each run is one task executed by the chosen agent in its own worktree. See [`docs/vectr-especificacao.md`](docs/vectr-especificacao.md) for the full spec (Portuguese) and [`docs/adr/`](docs/adr) for decisions.

## Requirements

- Node.js ≥ 22.18
- pnpm
- git
- At least one agent:
  - the `claude` CLI, logged in;
  - the `gemini` CLI with `GEMINI_API_KEY` from AI Studio;
  - the Antigravity CLI (`agy`), logged in with a Google account;
  - the `codex` CLI after `codex login`;
  - Ollama with a model that supports tool calls.

## Quick start

```sh
make install
make verify                     # typecheck + tests

node apps/cli/src/main.ts daemon start
node apps/cli/src/main.ts run --repo ~/code/my-repo --budget 1 --follow "Fix the failing date parser test"
node apps/cli/src/main.ts run show <run-id>
node apps/cli/src/main.ts daemon stop
```

Each run works on the branch `vectr/<run-id>/implement`, in a worktree under `~/.vectr/worktrees/`. Your checkout is never touched. Nothing is pushed or merged. The diff is saved as an artifact, and you review and merge the branch yourself.

Pick the agent with `--adapter`:

```sh
vectr run --adapter gemini-cli "Fix the typo in README.md"
vectr run --adapter antigravity --model gemini-3.8-flash-medium "Fix the typo in README.md"   # models: agy models
vectr run --adapter codex "Add a unit test for parse_date"
vectr run --adapter native --model ollama/qwen2.5:7b "Update the usage section in README.md"
vectr run --adapter native --model openrouter/<model>:free "…"   # needs OPENROUTER_API_KEY
```

Small local models are free but make more mistakes. Always read the diff (`vectr run show <id>`).

By default the agent may read and edit files and run a few read-only git commands. To let it run other commands, pass each one with `--allow`, for example `--allow "npm test" --allow "npm run *"`.

Runtime state lives in `~/.vectr`. Set `VECTR_HOME` to use another directory. Optional settings go in `~/.vectr/config.yaml`; see `apps/daemon/src/config.ts`.
