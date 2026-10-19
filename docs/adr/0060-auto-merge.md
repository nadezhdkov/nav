# 0060 — Opt-in auto-merge

- Status: accepted
- Date: 2026-10-19
- Builds on: spec §11.1, §19.8, ADR 0007 (GitHub token), ADR 0023 (budgets), ADR 0037 (PR watcher)

## Context

The Merge policy (AGENTS.md, spec §11.1) says merge is never automatic, with one opt-in exception per repository that only the user can turn on. Nothing implemented it. Four things in the spec needed a decision: where the setting lives, how a draft PR is merged, what "review without blocking findings" means when the reviewer's answer is free text, and what the kill switch does.

## Decision

1. **The setting lives in events, not in a file.** §11.1 names `github.auto_merge.enabled` in `.navarch/project.yaml`, but a PR that edits that file could then switch it on. The state is the latest `github.auto_merge.enabled|disabled` event of a project (`EventStore.autoMergeSettings`). The Policy Engine allows `automerge.set` only for the user from the desktop or CLI, and denies a paired phone, an agent and the system.
2. **Explicit confirmation by name.** `PUT /api/v1/projects/:id/auto-merge` turns it on only when `confirm` is the repository's `owner/name`; the CLI prints the conditions first (`navarch automerge on <project> --confirm <owner/repo>`). The project's autonomy level must be 3 or higher. Re-authentication (WebAuthn) joins when it exists.
3. **`AutoMerger` (`apps/daemon/src/github/automerge.ts`)** checks each open PR of Navarch's in an enabled project on a timer and merges only when all of these hold: the run is `pr_opened` at level 3+, not `ci-fix`, within its budget; the verification passed with checks and no protected path changed; the `reviewer` succeeded and declared `verdict: "approve"`, `blocking: 0`, `red: 0`; the head on GitHub is the commit Navarch pushed; the PR is from the same repository and targets the default branch, which must not be protected; GitHub shows at least one check run, all finished and green; no dependency manifest, lockfile, `.github/workflows/` file or `protected_paths` entry changed. Anything unknown (no review, no counts, no CI) means no merge. Release and deploy stay out of scope.
4. **The reviewer declares its counts.** The `reviewer` profile ends with a `navarch-outputs` block (`verdict`, `blocking`, `red`), read like other declared outputs (ADR 0032). Missing or non-zero never merges.
5. **Drafts.** Navarch's PRs are drafts, which GitHub cannot merge. `GitHubIntegration.autoMerge` marks the PR ready (GraphQL), merges with the head `sha` as a guard, and converts it back to a draft when the merge fails.
6. **Policy decides the merge.** `github.pr.merge` stays `require_approval` for everyone, and is allowed only for the `automerge` system actor when the repository is enabled and the level is 3 or higher.
7. **Audit and kill switch.** Enabling and disabling are events with the actor; each merge is `github.pr.merged` `{ sha, merge_sha, method, auto }` on the run. `fleet.stopped` disables auto-merge in every project (reason "kill switch"). Third-party PRs are never looked at: only PRs in `pull_requests`, which Navarch opened, are.

## Consequences

- 🟡 Repositories whose default branch is protected never auto-merge (spec: "branches protegidas nunca são alvo"); that is most real repositories, so the feature is for low-risk ones.
- 🟡 A repository without CI never auto-merges: `require_ci_green` cannot be disabled and zero checks are not green. Legacy commit statuses are not read.
- 🟡 The token needs Pull requests: write and Contents: write on the repository.
- 🟡 The reviewer's counts are the model's word. They add a gate; they do not replace the checks.
- 🔴 No Web UI toggle yet (CLI and API only), no WebAuthn, `strategy` other than squash is accepted but little tested.
