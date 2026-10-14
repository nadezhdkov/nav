---
name: domain-modeling
description: Build and sharpen VECTR's domain model while designing: challenge terms against the spec glossary (§4), stress-test concepts with concrete scenarios, check them against the code, and record resolved terms and real trade-offs (ADRs) as they land. Use when discussing VECTR terminology, editing the glossary, or deciding whether something deserves an ADR.
---

# Domain modeling

Adapted from Matt Pocock's `domain-modeling` skill (MIT, see [../THIRD_PARTY.md](../THIRD_PARTY.md)).

This is the active discipline: challenging terms, inventing edge cases, and writing down terms and decisions the moment they settle. Just reading the glossary for vocabulary is not this skill; any skill does that.

## Where the model lives

- **Glossary:** spec §4 "Glossário e conceitos centrais" in `docs/vectr-especificacao.md`. It is the only glossary; do not create a separate `GLOSSARY.md`. The spec is still in Portuguese (AGENTS.md › Language), so add rows in the table's language, with the English term in bold as the other rows do.
- **Decisions:** `docs/adr/NNNN-slug.md`, in English, in the format of ADR 0001 (Status, Date, Context, Decision, Consequences; add a `Spec:` line naming the sections it touches). Number = highest existing + 1. An ADR that changes the architecture lands together with the matching spec update.
- **Contracts:** the Zod schemas in `packages/contracts` are the code side of the model. Names there must match the glossary.

## During the session

**Challenge against the glossary.** When a term conflicts with §4, say so at once: "§4 defines Run as one execution of a Flow for a WorkItem, but you seem to mean a single agent attempt (a Task attempt). Which is it?"

**Sharpen fuzzy language.** Propose one canonical term for vague or overloaded words: "agent" can mean Agent Profile (role and instructions), Agent Adapter (how to run a CLI) or the model behind it.

**Use concrete scenarios.** Stress-test relationships with edge cases that force a boundary: a Task resumed after a daemon restart, a Run paused on quota, the same repository in two Projects, a reviewer from the same provider as the implementer.

**Check the code.** When the user says how something works, verify it in `packages/contracts` and the module, and surface contradictions with evidence (file:line, 🟢/🟡/🔴).

**Update the glossary inline.** When a term is resolved, edit §4 right away, not in a batch. Rules:
- Be opinionated: when several words name one concept, pick one and mention the ones to avoid in the definition.
- One or two sentences; say what it is, not what it does.
- Only terms specific to VECTR; general programming concepts (timeout, retry, cache) do not belong.

## ADRs, sparingly

Offer an ADR only when all three hold:
1. **Hard to reverse:** changing your mind later has a real cost.
2. **Surprising without context:** a future reader would ask "why this way?"
3. **A real trade-off:** there were genuine alternatives and one was picked for reasons.

Good candidates: architectural shape, integration between modules (events vs calls), technology with lock-in, scope and boundary decisions (including explicit "no"s, like ADR 0004's no multi-account rotation), deliberate deviations from the obvious path (ADR 0002's no build step), constraints not visible in the code. Open decisions in spec §19 become ADRs once decided (AGENTS.md › General).
