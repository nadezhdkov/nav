# 0040 — Phase 2 go/no-go without the Compete criterion

- Status: accepted
- Date: 2026-10-17
- Builds on: ADR 0031 (Compete mode), spec §16

## Context

Spec §16 gave Phase 2 two go/no-go criteria: a Flow made only in the UI and run without editing YAML, and Compete mode picking, by the user's own judgement, the best implementation in at least 70% of test cases.

The first was met on 2026-10-16 ([report](../reports/2026-10-16-flow-studio-go-no-go.md)). The second could not be measured: one Compete task costs about 3–4 times the quota of a single run, and on small, well-defined tasks one agent is usually enough. The user stopped the campaign after 2 of 10 cases and parked Compete ([report](../reports/2026-10-17-compete-go-no-go-parked.md)). The criterion is neither met nor failed.

## Decision

1. **The Compete criterion is dropped from the Phase 2 go/no-go**, by the user's decision on 2026-10-17. Phase 2 is closed on the Flow Studio criterion and on the scope delivered ([report](../reports/2026-10-17-phase-2-go-no-go.md)).
2. **Compete stays delivered but parked.** The code, ADR 0031 and `flows/compete.yaml` are kept. It is not run by default and nothing is built on it until the user picks a specific use, such as hard or ambiguous tasks where one agent often fails.
3. **The 70% criterion is not forgotten.** If Compete is taken up again, it needs a new criterion and a budgeted campaign, decided then.

## Consequences

- Spec §16 says so in the Phase 2 go/no-go, and `AGENTS.md` records Phase 2 as closed.
- 🔴 The Compete findings F-sched, F-spread and F-view of the parked report stay open until Compete is used again.
- 🔴 Compete's effectiveness is unproven: shipping it did not validate that picking among several agents beats one.
