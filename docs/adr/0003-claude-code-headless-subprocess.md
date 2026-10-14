# 0003 — Claude Code adapter runs the CLI as a headless subprocess

- Status: accepted
- Date: 2026-10-14
- Spec: §6.3.2, §19.4

## Context

The `claude-code` adapter can embed the Claude Agent SDK in-process or run the `claude` CLI headless. Phase 0 must run a task in a worktree, stream progress, cancel it, and resume it after the daemon restarts.

## Decision

Run `claude -p --output-format stream-json --verbose` as a subprocess with the worktree as its working directory:

- The prompt goes through stdin. Each stream-json line is written to the task log and parsed for progress, tool use, cost, usage and `permission_denials`.
- **Resume:** each first attempt passes a VECTR-generated `--session-id <uuid>`, recorded as a `task.resume_token` event before the process starts. A retried task passes `--resume <uuid>` and works in the same worktree. If the session no longer exists, the adapter starts a new one.
- **Policy:** the Policy Engine's grant becomes `--allowedTools` / `--disallowedTools` with `--permission-mode acceptEdits`. Commands outside the grant are denied, not prompted, and each denial becomes a `policy.denied` event.
- **Budget:** `--max-budget-usd` is set to the run's remaining budget.
- **Secrets:** GitHub token variables are removed from the subprocess environment.
- **Cancel:** SIGTERM, then SIGKILL after a grace period.
- **Authentication:** whatever the user's `claude` CLI is already logged in with. Users must check that automating it this way complies with the terms of the plan they use (spec §18).

## Consequences

- Real runs verified on 2026-10-14: a task completed, and a task interrupted by `vectr daemon stop` resumed the same Claude session after restart.
- The cost of an attempt killed mid-run is not recorded, because Claude Code reports cost only in its final `result` line. The Cost Ledger under-counts interrupted attempts until a per-turn estimate is added.
- The adapter depends on the stream-json format. The parser ignores unknown fields, and contract tests run against a fake CLI (`packages/adapters/claude-code/test/fixtures/fake-claude.mjs`).
