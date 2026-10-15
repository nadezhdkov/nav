---
name: new-pr
description: Publish a finished slice or feature branch, checking it, pushing it and opening a draft pull request against main, without asking the user again. The user reviews and merges. Use when a slice/feature is done and verified, or when the user says /new-pr, "push", "open the PR" or "publish".
---

# Publish a branch as a draft PR

The user has given standing permission (2026-10-15) to **push a feature branch and open a draft PR at the end of each slice or feature without asking**. Merging stays with the user: they review the PR and merge it themselves.

## Hard limits (never, even with this permission)

- Never merge, never enable auto-merge, never mark the PR ready for review, never approve it (Merge policy in `AGENTS.md`).
- Never push `main` or any branch you did not create for this work; never `--force` or `--force-with-lease`.
- Never push when checks fail. Fix the cause, or stop and tell the user.
- Never push secrets: if `git diff origin/main...HEAD` shows a key, token or `.env` content, stop.

## Steps

1. **Branch check.** You are in a worktree under `.worktree/<name>` on a feature branch (`feat/…`, `fix/…`, `docs/…`), not `main`. Commit any finished work with conventional messages; the tree must be clean (`git status --short` empty).
2. **Up to date with main.** `git fetch origin` and, if `origin/main` moved, rebase onto it (`git rebase origin/main`) before checking. If a rebase has conflicts you cannot resolve with confidence, stop and ask.
3. **Fresh checks**, for the code as it is now:
   - `ctk runq -- make verify` (typecheck + test).
   - `ctk runq -- make web-build` if `apps/web` changed (`git diff --name-only origin/main...HEAD`).
   - Then `ctk verify` must show a fresh ✓. Do not rely on an earlier run.
4. **Docs in sync.** "Current state" in `AGENTS.md` describes the slice; the slice spec in `docs/specs/` is marked implemented; the handoff file (`.claude/handoff/<branch>.md`) says "pushed, PR #N".
5. **Push.** `git push -u origin <branch>`.
6. **Open the draft PR** with `gh pr create --draft --base main --title "<conventional title> (Phase N slice M)" --body-file <file>`. Write the body file in the scratchpad, in English, following earlier PRs (e.g. `gh pr view 24`):
   - `## Summary`: one line with the slice, spec link and ADR, then bullets per area (core, API, CLI/concierge, Web, mobile).
   - `## Verification`: the exact commands and results (test count, commit SHA), screenshots or visual checks, anything CI-specific.
   - `## 🔴 Not done yet`: what is deferred and where it goes.
   - End with the attribution line from the session's system reminder.
7. **Watch CI.** `gh pr checks <N> --watch` (run it in the background if it is slow). If CI fails, fix it on the same branch, push again (no force), and say so.
8. **Report** to the user, in their language: PR URL, checks result, and the next slice. Do not ask for permission to push; just say it is waiting for their review and merge.

## After the user merges

Delete the worktree (`git worktree remove .worktree/<name>`) and the local branch, then start the next slice from fresh `origin/main` with the `new-worktree` skill.
