# Phase 3, slice 14: interview and review modes of `reverse-spec`

Status: implemented · Branch: `feat/phase-3-14-reverse-spec-modes` · Spec: §6.9.2 · ADR: 0055

`reverse-spec` can interview the user first and wait for a review before the PR. Both are off by default.

## Behavior

- Params `interview` and `review` (bool, default `false`) on `flows/reverse-spec.yaml`.
- `interview`: `scout` (profile `spec-scout`, read-only) lists the components and up to 8 questions, then `approve_scope` waits for the user. The user answers with `navarch say <run> "<answers>"` and approves; the writer receives the scout's answer as a `scope` input and the answers as an operator instruction. Rejecting cancels the run.
- `review`: after `save`, `approve_specs` shows the coverage summary and waits before `open_pr`.
- Answers make `inferred` claims marked "per the user"; unanswered questions become `gap` claims.
- Default (both off): behavior unchanged, no extra agent and no approval.

## Acceptance

- With `interview`, the run stops after the scout with the questions in the approval; the writer has not run; after `say` and approve, the writer's prompt carries the scope and the answer.
- Rejecting the scope cancels the run before the writer.
- With `review`, the specs are committed first, the approval shows the coverage, and approving finishes the run.
- Without either, no scout runs and no approval is created.

## Not in this slice

- The Archaeologist, Detective/Architect and Reviewer roles, per-step checkpoints, matching answers to numbered questions, a Web UI form for the interview.
