# VECTR

*Verified Engineering Coordination for Tasks and Repos*: a local-first coordination layer that runs coding agents (Claude Code first) in isolated git worktrees, records everything as events, and lets you follow and control the work from a CLI (Web UI and mobile come later).

Status: **Phase 0**. Each run is one task executed by Claude Code in its own worktree. See [`docs/vectr-especificacao.md`](docs/vectr-especificacao.md) for the full spec (Portuguese) and [`docs/adr/`](docs/adr) for decisions.

## Requirements

- Node.js ≥ 22.18
- pnpm
- git
- The `claude` CLI, logged in

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

By default the agent may read and edit files and run a few read-only git commands. To let it run other commands, pass each one with `--allow`, for example `--allow "npm test" --allow "npm run *"`.

Runtime state lives in `~/.vectr`. Set `VECTR_HOME` to use another directory. Optional settings go in `~/.vectr/config.yaml`; see `apps/daemon/src/config.ts`.
