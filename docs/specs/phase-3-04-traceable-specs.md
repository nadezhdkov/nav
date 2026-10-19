# Phase 3, slice 4: traceable specs and `reverse-spec`

Status: implemented · Branch: `feat/phase-3-04-traceable-specs` · Spec: §6.8.1, §6.9.2, §16 Phase 3 go/no-go · ADR: 0045

The second Phase 3 criterion: specs of a real project with at least 70% of their claims 🟢. A claim is only 🟢 when Navarch, not the agent, has checked its evidence against the code.

## Behavior

- The read-only profile **`spec-writer`** (tier `standard`) reads the code in the run's scope (the prompt) and ends its answer with one fenced `navarch-spec` JSON block per component: `component`, `title`, `summary` and `claims`, each `{ id, text, confidence: confirmed|inferred|gap, evidence: [{ file, line, quote }] }` (`parseSpecDrafts`, `SpecDraft` in `packages/contracts/src/specs.ts`; at most 60 claims and 6 pieces of evidence per claim).
- **Verification** (`verifyDrafts`, `packages/knowledge/src/specs.ts`), against the run's worktree: a piece of evidence is valid when its path is relative, has no `..`, resolves (symlinks included) inside the repository, the line exists and the `quote`, with whitespace squashed, appears on that line or within two lines of it. A claim stated `confirmed` keeps 🟢 only with at least one valid piece of evidence whose quote has 8+ characters; otherwise it becomes 🟡 with the reason (no evidence, file/line/quote not found, quote too short or missing). 🟡 and 🔴 claims are kept, their evidence marked valid or not.
- Action **`spec.write`** (policy action `spec.write`, always allowed: it writes only `.navarch/specs/` in the run's own worktree) writes `<component>.md` per component, `index.md` and `index.json` (with the coverage), and commits them on the run's branch `navarch/<run>/reverse-spec` (never pushed). It records `spec.generated` `{ components, claims, confirmed, inferred, gap, downgraded, green_rate, branch, files }`. A summary with no usable block is not a failure: the task outputs `saved: false` and the errors.
- Flow **`reverse-spec`** (`flows/reverse-spec.yaml`, needs a prompt): a loop of `write` ⇄ `save` until saved, up to `max_attempts` (2). The second write gets the errors as `previous_failures`.
- `GET /api/v1/specs` (devices may read it) returns the latest `spec.generated` per run with the run's codename; CLI `navarch specs` prints a table with the 🟢 share and the number of claims lowered.

## Acceptance

- A confirmed claim quoting code that is at the cited line stays 🟢; one citing a missing file, a line past the end, a quote that is not there, no quote, a quote under 8 characters, a path with `..`, an absolute path or a symlink out of the repository becomes 🟡.
- A run whose first answer is not valid JSON gets a second attempt with the error, and ends `done` with the specs committed on `navarch/<run>/reverse-spec`; the user's clone has no changes.
- `navarch specs` shows the run with its coverage.

## Not in this slice

- Guided mode (pause between steps) and the autonomous interview of §6.9.2, the Scout, Archaeologist, Detective/Architect and Reviewer roles, C4 diagrams and ERDs: one writer covers the scope.
- A PR for the specs (done in slice 7, ADR 0048), `spec-sync` addenda, `principles.md`, traceability matrices (`code ↔ spec`, `spec ↔ test`).
- A Web UI view. The 70% criterion is measured on a real project in the go/no-go campaign.
