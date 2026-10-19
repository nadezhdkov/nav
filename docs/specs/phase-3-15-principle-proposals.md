# Phase 3, slice 15: rules proposed by agents

Status: implemented · Branch: `feat/phase-3-15-principle-proposals` · Spec: §6.8.3 · ADR: 0056

Planner and reviewer can suggest project rules; the user accepts or dismisses them.

## Behavior

- A planner's or reviewer's summary may end with one `navarch-principles` block (`parsePrincipleProposals`: at most 3 rules, one line each, with a one-line reason; rules that do not fit are dropped one by one).
- On success the scheduler records `principle.proposed` for each new rule of a run in a registered project; other profiles are ignored. Known rules (the user's, pending, accepted or dismissed ones, compared without case) are not proposed again; at most 10 wait per project.
- `GET /api/v1/projects/:id/principles` adds `proposals`; `POST …/principles/proposals/:proposal/accept` (201, the new rule) and `…/dismiss` (204) are for the desktop and CLI only (policy `principles.set`).
- `navarch principles` lists proposals apart; `navarch principles accept|dismiss <id>`.
- Nothing reaches an agent's prompt until the user accepts a proposal.

## Acceptance

- The parser reads the last block, drops bad rules, caps at three and proposes nothing without a valid block.
- A team run whose reviewer proposes two rules (one on two lines) leaves one pending proposal and no rule; accepting it adds the user's rule linked to the run.
- Implementers' blocks, runs outside projects, repeated or dismissed rules and an eleventh waiting proposal are not recorded; a phone or an agent cannot decide; a decided proposal cannot be decided again.

## Not in this slice

- Proposals from the user's instructions or approval comments, a Web UI screen, a concierge tool, notifications.
