# 0048 — A draft PR for the specs `reverse-spec` writes

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0045 (traceable specs), ADR 0007 (GitHub token), ADR 0032 (PR actions), ADR 0039 (Away mode)

## Context

`reverse-spec` committed `.navarch/specs/` on `navarch/<run>/reverse-spec` and stopped: the branch stayed local, so the specs never reached the project, `specs_query` of the MCP server (ADR 0046) found nothing, and the planned `spec-sync` addenda had no specs to amend. `pr.create` could not help: it needs a work item (an issue or pull request) for the title, the `Fixes #N` line and the repository.

## Decision

1. **A new `github` node, `pr.specs`**, ends `reverse-spec`. It pushes the branch through the GitHub Integration (`navarch/*` only, never forced) and opens a draft PR into the default branch. The branch holds only the commit `spec.write` made, so the PR changes nothing but `.navarch/specs/`.
2. **Same policy action as `pr.create`:** `github.pr.create`. Below autonomy level 3 the PR waits for the user's approval, whose summary says how many files and claims it adds and the 🟢 share. Away mode does not take these approvals: the approver reviews code against an issue, and a spec PR stays with the user.
3. **The repository comes from the registered project** of the run's clone, not from an issue. Because a missing project or token would show up only after the agent's work, the run is refused at creation (`invalid_request`) without a project, and `checkPush` runs then, as for issue runs (finding F5). `flowNeeds` is `prompt` for this node.
4. **Opt out:** the Flow's param `open_pr` (default `true`); `--param open_pr=false` keeps the old behavior, the specs on the local branch, and skips both the project requirement and the node.
5. **The body** states the counts (🟢/🟡/🔴, how many were lowered by the evidence check), asks the reviewer to read the 🟡 and 🔴 claims, and embeds `index.md` (cut at 6,000 characters). The whole body is redacted.

## Consequences

- 🟡 The PR is tracked by the PR watcher (ADR 0037) like any other, so a specs PR counts in the acceptance rate and cost per merged PR. A rejected specs PR lowers the same metric as a rejected fix.
- 🟡 Rerunning `reverse-spec` for the same run id reuses the open PR (found by branch); a new run makes a new branch and PR. Specs are not merged with earlier ones yet.
- 🔴 No `spec-sync` after later merges, no Web UI view of the specs, and no way to push specs without a registered project.
