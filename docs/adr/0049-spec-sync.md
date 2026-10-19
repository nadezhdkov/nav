# 0049 — `spec-sync`: an addendum for each merged pull request

- Status: accepted
- Date: 2026-10-19
- Builds on: spec §6.8.1, ADR 0045 (traceable specs), ADR 0048 (PR for the specs), ADR 0032 (runs on pull requests)

## Context

Spec §6.8.1 asks for "post-delivery addenda": after a PR is merged, a `spec-sync` node describes what changed, without rewriting the original spec until the next full extraction. With the specs now reaching the project through a PR (ADR 0048), they go stale as soon as the next PR merges.

## Decision

1. **A Flow `spec-sync`, started on a merged pull request:** `navarch run --flow spec-sync --pr owner/repo#N`. The GitHub Integration reads the pull request, requires it to be merged (`pr_not_merged`), fetches the base branch and checks that the merge commit is still on it. The run works **on the merge commit**, so the code and the specs it reads are what is on the default branch, and the prompt's diff is the merge commit against its first parent, which is what the pull request brought in for merge, squash and rebase merges alike. `.navarch/project.yaml` is read at that first parent. `flowNeeds` says `merged_pull_request` for a Flow with a `spec.addendum` node; the pickers show it as needing a pull request.
2. **The read-only profile `spec-syncer`** (tier `standard`) reads the specs and the code and ends with one `navarch-addendum` block: a summary, `changes` (component, `added|changed|removed`, text, confidence, evidence) and `stale` (component and claim id of existing claims the merge may have made untrue, with a reason). The pull request's text and diff, like the code, are untrusted data.
3. **`spec.addendum` verifies, then writes.** Each change goes through the same evidence check as a spec claim (`verifyDrafts`): 🟢 only with a cited line and quote that are really there after the merge, else 🟡 with the reason. A removal has no code left to cite, so it stays 🟡 at best. A stale claim must exist as `**id**` in `.navarch/specs/<component>.md`; others are listed apart as "named, but not found" instead of being trusted. It writes only `.navarch/specs/addenda/pr-<N>.md`, commits it on `navarch/<run>/spec-sync` and records `spec.addendum.written`. The spec files are not touched. Policy action `spec.write` (always allowed, same as `reverse-spec`), and the Flow loops `write` ⇄ `save` as `reverse-spec` does.
4. **The PR reuses `pr.specs`** (ADR 0048): it takes whichever of `spec.generated` or `spec.addendum.written` came last, titles the PR `docs(specs): addendum for owner/repo#N` and puts the addendum in the body. Same approval below autonomy level 3, never delegated to Away mode; same `open_pr` param to keep it local.

## Consequences

- 🟡 It is started by the user for now. Starting it on every merge (the PR watcher already sees the merges Navarch opened) needs a cost cap like `ci_fix.auto` and is left for later.
- 🟡 The addenda are never merged back into the spec files; a later `reverse-spec` replaces them, which is the intended reading of §6.8.1. Two PRs that merge in the same minute write two files and do not conflict.
- 🟡 The diff in the prompt is cut at 40,000 characters, like other pull request runs; the agent can read the rest with `git diff` in the worktree.
- 🔴 No traceability matrix and no Web UI view of the addenda.
