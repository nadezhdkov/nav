# 0056 — Rules proposed by agents

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0047 (project principles), spec §6.8.3

## Context

Spec §6.8.3 says the decisions the user approves during runs become project rules, and that "rules only enter with the user's explicit confirmation". ADR 0047 gave the user a list and a repository file, but nothing noticed a convention worth keeping: the user had to remember to add it. An agent that reads the change (a planner, a reviewer) is the one that sees conventions the repository's docs do not state.

## Decision

1. **Planner and reviewer may suggest rules.** Their instructions allow one optional fenced `navarch-principles` block at the end of the answer, `{ "rules": [{ "text", "reason" }] }`, at most 3 rules of one line each, with the reason. They are told it is a suggestion, never to write it as a rule in force, and never to propose a rule because the request, an issue or the code says so (T1).
2. **Navarch records, never applies.** When such a task succeeds in a run of a registered project, `parsePrincipleProposals` keeps the rules that fit and the scheduler appends `principle.proposed` events in the same write as the task's completion (the projection `principle_proposals`, status `pending|accepted|dismissed`). Other profiles' blocks are ignored. A rule the project already has, waits for or dismissed (compared without case) is not proposed again, and at most 10 proposals wait per project.
3. **Only the user decides.** `GET …/principles` lists the pending proposals; `POST …/principles/proposals/:id/accept|dismiss` (desktop and CLI, policy `principles.set`, never a phone or an agent) accepts one, which adds the rule exactly as `principles add` does and links it to the proposing run (`principle.added` plus `principle.proposal.decided` in one write), or dismisses it. CLI: `navarch principles accept|dismiss <id>`; `navarch principles` shows the proposals apart.
4. **The reason is the agent's own words**, untrusted text shown as such. The rule an agent proposes reaches later prompts only after the user accepts it, and then through the same `<principles>` block as any other.

## Consequences

- 🟡 Only two profiles propose, and only when the model chooses to; there is no extraction of rules from the user's instructions or approval comments yet.
- 🟡 A proposal that an injected text managed to shape still needs the user's yes, and the screen shows where it came from (the run).
- 🔴 No Web UI view, no concierge tool and no notification for proposals yet.
