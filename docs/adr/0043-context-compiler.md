# 0043 — Context compiler from the code index, measured per task

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0042 (Explorer code index), ADR 0023 (token metrics)

## Context

Spec §6.8.2 asks for a compiled context per Task, and the Phase 3 go/no-go asks for at least 30% less input tokens per Task without a drop in PR acceptance. §19.7 leaves open whether the SCA is a library, a service or the engine itself. We have no SCA to integrate yet, and the code index of slice 1 already gives symbols with file and line.

## Decision

1. **A new package, `@navarch/knowledge`**, compiles the context from `@navarch/explorer` with no new dependency. The compiler is a function from (repository, task text, budget) to text plus its sources, so an SCA-backed compiler can replace it behind the same signature.
2. **Selection is lexical**: terms of the task are matched against symbol names, then excerpts and mentions are cut to a token budget. No model is called, so compiling costs nothing in tokens and cannot be prompt-injected into doing work.
3. **The block is untrusted data** in the prompt (delimited, origin named), like attachments and issue text (T1).
4. **Off by default, measurable.** `knowledge.context.enabled` is `false` until the go/no-go; `context.compiled` events record its size per task, and `attempts.tokens_in` already records what the agent consumed, so a campaign can run the same tasks with the setting off and on.
5. The compiler never fails a task: an error or a repository without git produces no block.

## Consequences

- 🟡 Lexical matching misses tasks described without the code's own words; the agent still has its own tools, so a miss costs only the block's tokens.
- 🟡 The context is read from the clone's working tree, which may differ from the run's base commit; reading at the base commit is a follow-up.
- 🔴 Whether the block lowers input tokens is not known until the go/no-go measures it; it may add tokens when the agent reads the same files anyway.
