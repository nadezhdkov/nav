# 0032 — Subflows, runs on pull requests, and the `review-pr` and `ci-fix` Flows

- Status: accepted
- Date: 2026-10-16
- Spec: §6.2.1 (`subflow`), §6.3.3 (`ci-fixer`), §6.7.4, §7.3 (Correção de CI), §11 T1, §16 (Phase 2), UC-08, UC-09
- Slice: [`docs/specs/phase-2-03-subflows-pr-flows.md`](../specs/phase-2-03-subflows-pr-flows.md)
- Builds on: ADR 0007 (fine-grained PAT), ADR 0011 (Flow engine), ADR 0031 (composite nodes)

## Context

Phase 2 asks for `subflow` nodes and for the `ci-fix` and `review-pr` Flows. Until now every run worked on an issue or a prompt, and every GitHub write was a push of a `navarch/*` branch followed by a draft PR. Reviewing someone's pull request means working on code that is neither ours nor trusted. Fixing CI means pushing to a pull request's branch, which is not ours either.

## Decision

1. **`subflow` is a composite node that runs the child through the same `next()`**:
   - The child's tasks carry ids prefixed with the node's id. The child sees only its own tasks, its params come from `with`, and the node's `inputs` reach every agent task of the child.
   - The run keeps copies of its children (`RunFlow.subflows`).
   - One level only, with no `team`, `compete` or `subflow` inside. The team and compete views read top-level nodes, and nesting brings nothing yet.
   - References are checked when `flows/` is loaded.
2. **Agents may declare outputs** in a fenced `navarch-outputs` JSON block. Only scalar fields are kept, and `summary` cannot be replaced. This gives `when` something to branch on (`kind == 'code'`) without a `switch` node.
3. **A run can start on a pull request** (`--pr`). Its worktree starts at the pull request's head, fetched into `refs/navarch/pr/<N>/*`. Its project config is read at the pull request's **base**, so a pull request cannot widen what Navarch runs on it (T1). The diff, the body and the failing checks' logs are untrusted data in one delimited block of the prompt.
4. **Navarch comments, it never judges a pull request on GitHub.** `pr.review` always posts with the event `COMMENT`, whatever the reviewer's verdict, in line with the merge policy (§11.1): approving is the human's act. Inline comments go only on lines the diff shows. Every posted text carries a `navarch:<run>` marker, so a retry finds it instead of posting twice.
5. **`ci-fix` pushes only its own branch.** The fix goes to `navarch/<run>/ci-fix` and opens a draft PR whose base is the pull request's branch. Navarch never pushes to that branch. §7.3 names the branch `navarch/ci-fix/<pr>`; the run-branch convention (`navarch/<run>/<flow>`) is kept instead, so retries and parallel runs never collide. `ci-fix` refuses pull requests from forks: their branch cannot be a base in the same repository, and their code would run in verification.
6. **New policy actions** `github.pr.review` and `github.pr.comment` follow `github.pr.create`: allowed at autonomy level 3 and approved below it.

## Consequences

- The Flow engine can reuse Flows. `ci-fix` reuses `task` for its fix loop, and later Flows can reuse `review-pr`.
- The fine-grained PAT needs Pull requests write to post reviews and comments, which it already has for draft PRs.
- Writing refs under `refs/navarch/` touches the operator's clone. Branches and tags are left alone.
- Not yet: GitHub event triggers (`check_run`, comment commands), nested subflows, tier escalation on retry.
