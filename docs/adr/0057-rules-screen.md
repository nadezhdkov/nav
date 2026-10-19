# 0057 — A Rules screen in the Web UI

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0056 (rule proposals), ADR 0047 (project principles), ADR 0017 (Web UI)

## Context

Rule proposals (ADR 0056) could only be decided with `navarch principles accept|dismiss`, so the user had to know to look. The Web UI is where approvals and the Inbox already live.

## Decision

1. `/rules` (desktop tab "Rules") lists, per registered project, the rules agents read and the proposals waiting for a decision, with Accept and Dismiss. It uses the existing routes (`GET …/principles`, `POST …/principles/proposals/:id/accept|dismiss`) and adds no API.
2. The tab's badge counts pending proposals across projects. The store refetches on `principle.*` and `project.*` events.
3. Accept and Dismiss are hidden on a paired phone, as the API refuses them there (`principles.set`). The reason is shown as plain text and the page says a proposal is not applied until accepted.
4. A refused decision keeps its message on screen after the list reloads.

## Consequences

- 🟢 No new contract or policy; the screen only reads and calls what ADR 0056 added.
- 🟡 Adding or removing the user's own rules still happens in the CLI.
- 🔴 No screenshot check of this screen yet, no concierge tool and no notification for proposals.
