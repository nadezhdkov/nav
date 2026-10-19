# Phase 3, slice 8: `spec-sync`

Status: implemented · Branch: `feat/phase-3-08-spec-sync` · Spec: §6.8.1 (post-delivery addenda), §16 Phase 3 · ADR: 0049

After a pull request is merged, an addendum says what it changed in terms of the specs, and a draft PR carries it.

## Behavior

- `navarch run --flow spec-sync --pr owner/repo#N` (registered project needed). The pull request must be merged; an open one answers 400 `not merged`. The run works on the merge commit.
- Profile **`spec-syncer`** answers with a `navarch-addendum` block (`parseAddendumDraft`): `summary`, `changes[]` and `stale[]`.
- Action **`spec.addendum`** (policy `spec.write`) verifies the changes' evidence against the code (`verifyAddendum`), checks the stale claims against `.navarch/specs/<component>.md`, writes `.navarch/specs/addenda/pr-<N>.md` (`renderAddendum`), commits it on `navarch/<run>/spec-sync` and records `spec.addendum.written`. Unusable answers loop back to the agent (`max_attempts`, 2).
- Then `pr.specs` opens a draft PR with the addendum (approval below autonomy level 3, `open_pr=false` to skip).

## Acceptance

- Against the fake GitHub with a squash-merged pull request: the agent gets the merge's diff, is told what was wrong with a broken first answer, and the PR adds only `.navarch/specs/addenda/pr-7.md`; the 🟢 change keeps its mark, the removal and an unquoted claim are 🟡, an existing stale claim is listed, one that does not exist is listed apart.
- An open pull request is refused.

## Not in this slice

- Starting `spec-sync` automatically on merges, merging addenda into the specs, traceability matrices, a Web UI view.
