# 0055 — Interview and review modes of `reverse-spec`

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0045 (traceable specs), spec §6.9.2 (guided and autonomous modes)

## Context

Spec §6.9.2 describes two modes of `reverse-spec`: **guided**, which pauses between steps, and **autonomous**, which asks all its questions in one interview up front and records later doubts as 🟡 instead of interrupting. Until now the Flow only had a single write-and-save pass, with no question and no pause.

## Decision

1. **Two switches, off by default**, as Flow params (typed, so a typo is refused):
   - `interview` (`--param interview=true`): a read-only **`spec-scout`** (tier `standard`) looks over the scope, proposes the components and asks at most 8 numbered questions the code cannot answer. An approval node `approve_scope` then pauses the run showing the scout's answer.
   - `review` (`--param review=true`): an approval node `approve_specs` pauses the run after the specs are written and committed, showing the coverage summary, before the PR.
   - Both on is the guided mode. Neither is the autonomous mode that exists today, which asks nothing.
2. **Answering reuses run instructions.** The user answers with `navarch say <run> "<answers>"` (or the Web UI) and approves; the next agent, the writer, gets the scout's answer as a `scope` input and the answers as an `<operator_instruction>` (ADR 0019). No new answer channel.
3. **The writer treats answers as the user's word.** A claim built from an answer is `inferred` and says "per the user", since only code can confirm a claim (ADR 0045). Questions left unanswered become `gap` claims; the writer never stops to ask again.
4. **Approvals are the user's.** They are ordinary Flow approvals (`flow.approval`); Away mode delegates only `approve_plan`, so these two stay with the user. Rejecting `approve_scope` cancels the run before the writer starts.
5. `spec.write` now exposes its `summary` as an output, which is what `approve_specs` shows.

## Consequences

- 🟡 The scout is one agent, not the five roles of §6.9.2 (Scout, Archaeologist, Detective/Architect, Writer, Reviewer); the writer still covers the whole scope in one pass.
- 🟡 No checkpoints between steps beyond the two approvals, and the user's answers are free text, not matched to numbered questions.
- 🔴 The pause after the specs is a review of the summary, not of each claim; the draft PR still carries the files for a line-by-line review.
