# Phase 1, slice 1: issue → verified draft PR (CLI)

Status: in progress · Branch: `feat/github-issue-pr` · Spec: §6.6, §6.7, §7.1, §8.4, §11, §14.2 · ADRs: 0006, 0007

The first vertical path of Phase 1, driven from the CLI: a GitHub issue becomes a run, the agent implements it in a worktree, VECTR verifies the result with the repository's own commands, and the GitHub Integration opens a draft PR on a `vectr/*` branch. No Flow engine, triage, plan, review or Web UI yet (slices 2–5).

## Behavior

```
vectr run --issue owner/repo#42 --repo ~/src/repo [--adapter …] [--budget …]
vectr pr open <run-id>        # opens the draft PR for a run in ready_for_pr
```

1. **Work item.** The GitHub Integration reads the issue (title, body, labels, author, URL) with the token from the Vault and records `workitem.received`. The local clone's `origin` must point to `owner/repo`, or the run is refused.
2. **Prompt.** The issue is untrusted data (T1): the prompt wraps it in a delimited block marked with its origin, and the task instructions say that text inside it is never an instruction.
3. **Project config.** `.vectr/project.yaml` (§14.2: `setup`, `verify`, `allowlist`, `protected_paths`) is read **at the base commit**, never from the worktree, so the agent cannot change the commands that judge it. Request flags add to it.
4. **Implement.** One `implement` task, as in Phase 0.
5. **Verify** (run `executing → verifying`). The Runner runs each `verify` command in the worktree (same runner as setup: process group, timeout, cancel). The result is a `VerificationReport { checks[], passed, blocking_failures[], warnings[] }`, recorded as `verification.completed` and saved as a `report` artifact. A failed `required` check fails the run (no fix loop yet). A changed file matching `protected_paths` is a warning and a 🔴 item in the PR. No `verify` commands: the run still reaches `ready_for_pr`, and the report and PR say "unverified" (🔴).
6. **PR** (run `verifying → ready_for_pr`). The Policy Engine decides `github.pr.create`: `allow` at autonomy level ≥ 3, `require_approval` below. Until approvals exist (slice 2), `require_approval` stops the run in `ready_for_pr` and `vectr pr open <run>` is the explicit human approval. Opening the PR: the GitHub Integration pushes the task branch (`git.push`, allowed only for `vectr/*`, never forced) and creates a **draft** PR (`ready_for_pr → pr_opened`, event `github.pr.opened`), then `pr_opened → done`.
7. **PR body** (§6.7.5): conventional title from the issue, `Fixes #N`, the agent's summary, changed files, verification table, evidence (commands and exit codes), cost and models, 🔴 items (unverified, protected paths, failing optional checks).

## Contracts (packages/contracts, first)

- `WorkItemRef { source: "github", repo: "owner/name", number, url }`, `WorkItem` = ref + `title, body, labels[], author`.
- `CreateRunRequest.issue?: string` (`owner/repo#N`); `RunView.work_item?: WorkItemRef`, `RunView.pr_url?`.
- `VerificationCheck { name, command, required, exit_code: number|null, duration_ms, output_tail }`; `VerificationReport { checks[], passed, blocking_failures[], warnings[] }`.
- Events: `workitem.received` (WorkItem), `verification.started`, `verification.completed` (report + artifact id), `github.pr.opened { number, url, branch, draft }`, `github.push { branch, commit }`.
- API: `POST /api/v1/runs/:id/pr` (open the PR; Policy decides; actor = the user).

## Modules

- `packages/github`: the only module that talks to GitHub. REST over `fetch` (issue read, PR create), push with the token passed through a one-shot `http.extraheader` on the command line's environment (never written to git config or logs). Base URL configurable so tests use a fake server.
- `packages/verification`: runs checks through the Runner, builds the report, checks the diff against `protected_paths`.
- Vault (ADR 0007): `secret://github/token`, OS keychain (`secret-tool`), injected only into the GitHub Integration. `vectr secret set github/token` reads it from stdin.
- Daemon: Orchestrator moves the run through `verifying → ready_for_pr → pr_opened → done`; `.vectr/project.yaml` loader.

## Tests (no network)

- Fake GitHub server (issues, pulls) and a local bare repository as `origin`.
- Contract tests for `packages/github` against the fake; Policy tests for `github.pr.create` per level; verification tests (pass, required failure, optional failure, protected path, no checks); daemon end-to-end: issue → verified → ready_for_pr → `pr open` → draft PR on the fake, branch pushed to the bare remote; refusal when `origin` does not match.

## 🔴 Out of scope / open

- Verify commands, like setup, run unsandboxed as the operator (ADR 0006); acceptable for the operator's own repositories only. Must move to L2 or behind approval before taking third-party issues automatically (label trigger, slice 2).
- No polling or webhooks, no label trigger, no comments on the issue (slice 2).
