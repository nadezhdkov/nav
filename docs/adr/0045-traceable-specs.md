# 0045 — Specs whose green claims Navarch checks itself

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0043 (context compiler), spec §6.8.1 (confidence scale), §6.9.2 (Reversa-style Flow)

## Context

The Phase 3 go/no-go wants specs of a real project with at least 70% of their claims 🟢 (confirmed from the code, with file and line). If the agent that writes the spec also decides which claims are 🟢, the rate measures how confident the agent sounds, not how well the spec is grounded.

## Decision

1. **The agent proposes, Navarch decides.** The writer states a confidence and evidence (file, line, verbatim quote). Navarch checks the evidence against the run's worktree and keeps 🟢 only for claims whose quote is really at the cited place; it lowers the others to 🟡 and writes why. The go/no-go rate is the share of claims that kept 🟢.
2. **The agent never writes the files.** The profile is read-only; the action `spec.write` renders and commits `.navarch/specs/` from the verified claims, which satisfies "spec agents write only to `.navarch/specs/`" structurally and keeps the format uniform.
3. **A quote of 8+ characters within two lines** is the smallest check that cannot be passed by a vague citation but survives small line shifts. It proves the code says it, not that the claim is a correct reading of it.
4. **One writer and a retry loop in v1**, as a Flow (`reverse-spec`), not the five Reversa roles: the verification is what grounds the result, and more roles can be added as nodes later. Output stays on a local branch; a PR needs a work item the Flow does not have yet.

## Consequences

- 🟡 A 🟢 claim is grounded, not necessarily right: the quote may be real and the interpretation wrong. Reviewing a sample is part of the campaign.
- 🟡 Honest agents are not penalised for gaps: 🔴 and 🟡 claims count in the denominator, so a spec that marks everything 🟢 only by quoting trivia still shows its claims, and a spec of mostly gaps scores low by design.
- 🔴 The rate can be pushed up by writing only easy claims; the claims per component and the review of a sample bound that.
