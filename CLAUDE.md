@AGENTS.md

## Claude Code

- Before implementing a module, read the matching section of `docs/vectr-especificacao.md` (about 1500 lines: use Grep or offsets instead of reading it all).
- The project has no code and no git yet. When Phase 0 scaffolding starts, propose `git init`, add `.worktree/` to `.gitignore`, and use the `new-worktree` skill (worktrees under `.worktree/<name>`) for each phase or feature.
- Project skills go in `.claude/skills/` and are mirrored in `.agents/skills/`.
- When build, test or lint commands are introduced, create the `Makefile`, update "Current state" in `AGENTS.md`, and run them through `ctk runq -- make <target>`.
- Never enable or perform an auto-merge on your own; see "Merge policy" in `AGENTS.md`.
- Do not claim tests pass without a fresh `ctk verify`.
