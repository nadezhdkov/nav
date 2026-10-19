# Phase 3, slice 2: context compiler

Status: implemented · Branch: `feat/phase-3-02-context-compiler` · Spec: §6.8.2, §16 Phase 3 · ADR: 0043

The Knowledge Engine's second question: what is the minimum context this Task needs? Instead of every agent rediscovering the repository with its own reads and searches, Navarch compiles a small, evidence-bearing package from the code index (slice 1) and puts it in the task prompt.

## Behavior

- `@navarch/knowledge` exports `compileContext({ root, task, maxTokens? })` → `CompiledContext` `{ text, sources, chars, est_tokens, ms }`. It reads the clone with `@navarch/explorer` and never writes.
- Sections, in priority order, each cut to fit `maxTokens` (default 4,000; 1 token ≈ 4 characters):
  1. **Map**: main languages, frameworks, entry points and top-level directories, on a few lines.
  2. **Symbols**: definitions whose names match terms of the task (identifiers in backticks, camelCase/snake_case words, file names), each with `file:line`, kind and exported flag, at most 15.
  3. **Excerpts**: for the best-ranked symbols, the declaration plus the lines after it (at most 30 lines, 6 excerpts), numbered.
  4. **Mentions**: literal text hits of the strongest term, at most 8, for places that are not declarations.
- Every item names its source (`file:line`), so the agent can check it; the block says it is a starting point from a line-based index, not the whole truth (🟡).
- The text comes from the repository, so the prompt carries it in a delimited `<context>` block, marked untrusted, after the task and before the inputs, and it cannot close the block.
- The scheduler compiles it for agent tasks of profiles `triager`, `planner`, `implementer`, `researcher` and `lead`, when `knowledge.context.enabled` is true (default `false` until the go/no-go measures it). A failure to compile never fails the task: the agent runs without the block.
- Event `context.compiled` `{ chars, est_tokens, sources, ms, max_tokens }` on the task, so the go/no-go can compare input tokens (`attempts.tokens_in`) with and without the block, per profile.
- Config: `knowledge.context.enabled`, `knowledge.context.max_tokens`.

## Acceptance

- For a task naming `parseTeamPlan`, the context lists its definition in `packages/contracts` with the right line and an excerpt that contains the declaration.
- The block never exceeds `max_tokens × 4` characters.
- A task with no matching term still gets the map and no empty sections.
- A repository path that is not a git repository yields no block and an unchanged prompt.
- With `enabled: false` the prompt is byte-identical to today's.

## Not in this slice

- Specs and decisions as sources (`.navarch/specs/`, ADRs), PR history, dependency graph, semantic ranking, the SCA, MCP exposure. The context is read from the clone's working tree, not from the run's base commit.
