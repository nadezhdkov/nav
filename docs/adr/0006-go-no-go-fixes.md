# 0006 — Agents run with their own configuration, know their allowlist, and get a prepared worktree

- Status: accepted
- Date: 2026-10-14
- Spec: §6.1.2 (Scheduler), §6.3.1 (task context), §9.2 (events), §10.2 T1/T2, §14.2 (`setup`)
- Evidence: [Phase 0 go/no-go report](../reports/2026-10-14-phase-0-go-no-go.md), findings F1–F4, F6, F7

## Context

The Phase 0 go/no-go ran 10 real tasks. The tasks themselves went well, but the agents around them were badly set up:

- **F1:** gemini-cli read the operator's global auth choice (`oauth-personal`), which Google now rejects, so every gemini-cli run failed in seconds.
- **F2:** `claude -p` loaded the operator's own `~/.claude` (CLAUDE.md, hooks, plugins), which pushed the agent toward tools outside the run's allowlist.
- **F3:** nothing told the agent which commands it could run, so its guesses were near-misses the policy denied.
- **F4:** worktrees had no dependencies installed, and agent sandboxes have no network, so most agents could not run their own tests.
- **F6:** after a restart, interrupted tasks were queued behind tasks that had never started.

## Decision

- **Each agent runs with VECTR's configuration, not the operator's.**
  - claude-code: `--setting-sources project,local` by default (`adapters.claude-code.setting_sources`), so user-level CLAUDE.md, hooks and plugins are not loaded. The subscription login still works, which `--bare` would break. The target repository's project settings still load, so T1 now also covers them.
  - gemini-cli: per-task `GEMINI_CLI_HOME` under `<VECTR_HOME>/agents/gemini-cli/`, with `settings.json` selecting `gemini-api-key` and a symlink to the operator's `~/.gemini/.env`, so the key is never copied. The home is kept after a failure, so a retry can resume the session. When no `GEMINI_API_KEY` is available, the task fails at once with a fatal error saying where to put the key. This follows the per-task HOME that antigravity already uses (ADR 0004).
- **The task context lists the allowlist.** `buildInstructions` adds a "Commands you may run" section from the grant (`x` exactly, or `x` followed by any arguments) before `<task>`. The grant is still enforced by each adapter; the list only stops the agent from guessing.
- **Setup commands prepare the worktree.** `CreateRunRequest.setup_commands` (CLI `vectr run --setup <cmd>`, repeatable; later `setup:` in `.vectr/project.yaml`, §14.2) is recorded in `run.created`.
  - The Runner runs these commands in the sandbox before the agent's first attempt, through `sh -c`, with network and the operator's environment minus `DEFAULT_SCRUB_ENV`.
  - Each command emits `sandbox.setup` (command, exit code, duration), and its output goes to the task log.
  - A marker in the run's log directory makes setup run once per sandbox, across retries and restarts.
  - A failing command fails the task as fatal and the agent is not started.
  - Cancelling the task or stopping the daemon kills the running command and its process group; the agent is not started. The Scheduler gives each task an `AbortSignal`, so a cancel or stop also reaches a task between dispatch and the agent's process.
  - Setup is opt-in, never auto-detected: an implicit `npm ci` would run third-party install scripts (T2) without anyone having asked.
- **Already-attempted tasks are dispatched first.** The Scheduler orders ready tasks so that those with `attempt > 0` go first, keeping FIFO order within each group.
- `vectr run list` shows one line per run: the brief's `**Summary:**` line or the first line of the prompt. Multi-line reasons in `vectr logs` are folded onto one line.

## Consequences

- An agent's behavior depends on the run's grant and the repository, not on whoever operates the daemon.
- Setup outputs such as `node_modules` and `.venv` must be ignored by the repository's `.gitignore`, or they show up in the diff artifact.
- Setup commands run unsandboxed as the operator. They are the operator's own commands for their own repositories (Phase 0). Once Phase 1 runs work from third parties, setup moves to the L2/L3 sandbox or behind an approval.
- F5 ("succeeded" is not "verified") is left to the Phase 1 Verification module.
