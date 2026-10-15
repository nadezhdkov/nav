# 0021 — Project registry, GitHub polling and Inbox triage on an API model outside runs

- Status: accepted
- Date: 2026-10-15
- Spec: §4, §6.7.3, §6.14, §8.2, §9.1, §15.1, §15.3, §16 (Phase 1 "Web UI: Inbox"), §19 idea 1
- Slice: [`docs/specs/phase-1-08-inbox.md`](../specs/phase-1-08-inbox.md)
- Builds on: ADR 0007 (GitHub PAT), ADR 0013 (Model Router), ADR 0014 (free models), ADR 0016 (concierge on the native client), ADR 0020 (device scope)

## Context

The Inbox of §15.3 lists triaged WorkItems from every source, and starting runs from it is the Phase 1 entry point for issue work. Three things were missing:

1. **Which repositories to watch.** No project entity exists. Runs carry a repository path, and nothing lists the user's repositories.
2. **How issues arrive.** The daemon sits on loopback behind Tailscale, so GitHub cannot reach it with webhooks unless a relay exists (Phase 4).
3. **When and how to triage.** Today only a run's `triage` node triages, as a CLI agent in a worktree. Running a CLI agent for every open issue would spend subscription quotas and create one worktree per issue.

## Decision

1. **A project registry built from events.** `project.added` and `project.removed` events, with the projects as a projection. In Phase 1 a project is one local clone of one GitHub repository. The event carries the repository fields, so the Project/Repository split of §8.2 can come later without migrating data. Repository rules stay in `.navarch/project.yaml`, read at the run's base commit.
2. **Polling with ETags, manual sync on demand.** This is the §6.7.3 fallback for when there is no public URL. The default interval is 15 minutes, and each request is conditional, so an unchanged repository costs no rate limit. Webhooks wait for the relay.
3. **Inbox triage on an API model outside runs.** The daemon triages each new or changed item with a `native` API model, the way the concierge works. It uses profile `inbox`, tier `fast` by default, so free models come first. There is no worktree, no tool and no repository access. The answer must be a small JSON object validated by Zod. A daily cap on items and on dollars is enforced by the Policy Engine (`inbox.triage`). A run started from an item still runs its own triage with the repository, because the Inbox triage only sorts.
4. **Estimates from observed costs only.** The median cost of finished `fix-issue` runs with the same complexity, or no estimate. Nothing is priced by hand.
5. **Device scope.** A paired phone may read the Inbox, start issue runs from it in registered projects, dismiss and sync. Project changes stay on the PC. This widens ADR 0020's "new runs only as a prompt in a repository of earlier runs" to "issue runs from the Inbox in registered projects", which is still a repository the user chose on the PC.

## Consequences

- The Inbox works without any CLI agent quota. When no API model is configured, it still lists and starts runs, just untriaged.
- Free models' daily limits are tracked as quotas (ADR 0014), so triage falls back or waits like any other routed call.
- WorkItem statuses (`new`, `triaged`, `in_run`, `done`, `dismissed`, `closed`) are added to §8.2. Run and Task states do not change.
- A model sees issue text from strangers. This exposure is limited the same way the concierge's is: delimited input, no tools, and output reduced to enums and short plain text.

## Alternatives considered

- **Triage with the run's triager on CLI agents.** Rejected: one worktree and subscription quota per issue.
- **No model, only heuristics.** Rejected by the user, because complexity, area and duplicates are what make the Inbox worth having.
- **Repositories of earlier runs instead of a registry.** Rejected: there is no way to add a repository before its first run, and nowhere to hang per-project budgets later.
