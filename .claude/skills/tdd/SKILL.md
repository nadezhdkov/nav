---
name: tdd
description: Test-driven development in Navarch, one red → green slice at a time, with tests at agreed seams and fakes only at system boundaries. Use when building a feature or fixing a bug test-first, or when the user mentions red-green, TDD or integration tests.
---

# Test-driven development

Adapted from Matt Pocock's `tdd` skill (MIT, see [../THIRD_PARTY.md](../THIRD_PARTY.md)).

TDD is the red → green loop. This skill is what makes the loop produce tests worth keeping: what a good test is, where tests go, the anti-patterns and the rules of the loop. Apply every section on every cycle.

Before starting, read the spec section for the module (`docs/navarch-especificacao.md`, by section number) and the ADRs in `docs/adr/` that touch it, so test names use the domain terms of spec §4 (Run, Task, TaskGraph, Agent Adapter, Policy…).

## What a good test is

A test checks behavior through a public interface, not implementation details. The code can change completely; the test should not. A good test reads like a specification ("a rate-limited task waits until the reported reset") and survives refactors because it does not depend on internal structure.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for when to fake.

## Seams: where tests go

A **seam** is the public boundary you test at. In Navarch the usual seams are:

| Seam | Test through |
|---|---|
| Core API | HTTP calls to `/api/v1/...` on a daemon started on a temporary `NAVARCH_HOME` (as `apps/daemon/test/daemon.test.ts` does) |
| Event store and projections | appending events and reading the projected views |
| Agent adapter | the `AgentAdapter` contract from `packages/contracts`, with a fake CLI (`packages/adapters/*/test/fixtures/fake-*.mjs`) or the fake model server (`packages/adapters/native/test/fake-server.ts`) |
| Policy Engine | `decide(actor, action, resource, context)` |

**Test only at agreed seams.** Before writing a test, write down the seams under test and confirm them with the user, each with one line on what it catches and what it misses. You cannot test everything; agreeing on seams puts the effort on the critical paths.

## Anti-patterns

- **Implementation-coupled:** mocks internal collaborators, tests private functions, or checks through a side channel (reading SQLite directly instead of the projection or API). The tell: the test breaks on a refactor that did not change behavior.
- **Tautological:** the expected value is recomputed the way the code computes it, so the test passes by construction. Expected values come from an independent source: a literal, a worked example, the spec.
- **Horizontal slicing:** all tests first, then all code. Bulk tests check imagined behavior. Work in **vertical slices**: one test, one implementation, repeat, each slice responding to what the previous one taught you.

## Rules of the loop

- **Red before green.** Write the failing test, run it and see it fail for the right reason, then write only enough code to pass.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **No network, no cost.** Tests never call a real agent CLI or a paid model; extend the fakes instead (AGENTS.md › Current state).
- **Run tests through the Makefile:** `ctk runq -- make test` during the loop, `ctk runq -- make verify` before committing, and do not claim green without a fresh `ctk verify`.
- **Refactoring is not part of the loop.** It belongs to the review stage (`review-two-axis` skill).
