# Phase 2 go/no-go — 2026-10-17

**Criteria (spec §16, Phase 2):**
1. Create a new Flow only in the UI and run it without editing YAML.
2. Compete mode picks, by the user's own judgement, the best implementation in ≥ 70% of test cases.

**Verdict: go. Criterion 1 is met; criterion 2 was dropped by the user (ADR 0040).**

## Criterion 1: met

`plan-and-pr` was built and published through the Flow Studio alone, ran from New run and from an issue, and opened the draft PR vectr-sandbox#9. Details and findings F1–F7 are in [2026-10-16-flow-studio-go-no-go.md](2026-10-16-flow-studio-go-no-go.md).

## Criterion 2: dropped

The campaign stopped after 2 of 10 cases because of its cost, so the rate was never measured ([2026-10-17-compete-go-no-go-parked.md](2026-10-17-compete-go-no-go-parked.md)). The user decided on 2026-10-17 to dispense with it for now; Compete stays parked. The reasoning is in [ADR 0040](../adr/0040-phase-2-go-no-go-without-compete-criterion.md).

## Scope delivered (spec §16)

| Scope item | Slice | ADR |
|---|---|---|
| Parallel team members with their own worktrees | 1 | 0029 |
| Compete mode (parked) | 2 | 0031 |
| `subflow` node, `review-pr`, `ci-fix` | 3 | 0032 |
| Flow Studio: editor, validation, simulation, versions | 4 | 0033 |
| L2 container for verification | 5 | 0035 |
| `parallel` node with `join` | 6 | 0036 |
| Cost and quality panels | 7 | 0037 |

Beyond the §16 scope: Away mode and the approver (slice 8, ADR 0039), the public site (ADR 0038) and CodeQL with dependency review in CI (#58).

## 🔴 Open

- Compete's effectiveness is unproven; findings F-sched, F-spread and F-view stay open.
- The quality panels (ADR 0037) have not yet been read against the §17 targets on real PR history.
- Not built, per `AGENTS.md`: editing parallel branches, L3, label/webhook/`check_run` triggers, PR runs from the Web UI, the morning summary, WebAuthn, relay.
