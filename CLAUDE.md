@AGENTS.md

## Claude Code

- Before implementing a module, read the matching section of `docs/navarch-especificacao.md` (about 1500 lines: use Grep or offsets instead of reading it all).
- Use the `new-worktree` skill for each phase or feature, with worktrees under `.worktree/<name>` (already in `.gitignore`).
- Project skills go in `.claude/skills/` and are mirrored in `.agents/skills/`.
- Run project commands through the `Makefile` with `ctk runq -- make <target>`. When you add a command, add a target and update "Current state" in `AGENTS.md`.
- Never enable or perform an auto-merge on your own; see "Merge policy" in `AGENTS.md`.
- Do not claim tests pass without a fresh `ctk verify`.
