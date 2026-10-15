# Phase 1, slice 8: projects, Inbox and desktop Home

Status: in progress · Branch: `feat/inbox` · Spec: §4 (WorkSource, WorkItem), §6.7.3, §6.14, §8.2, §9.1, §15.1, §15.3, §16 (Phase 1 "Web UI: Inbox") · ADR: 0021

Phase 1 asks for an Inbox in the Web UI: every open issue of the user's repositories in one list, triaged, with a suggested action and a cost estimate, and a way to start runs from it (§15.3). Today a run starts only from an issue reference typed by hand, the GitHub Integration reads one issue at a time, and triage happens only inside a run. This slice adds a project registry, a GitHub sync by polling, automatic triage on a cheap API model, the Inbox screen, and the desktop Home of §15.1 with the agents' quota windows.

User decisions (2026-10-15): repositories come from a **project registry**; triage runs **automatically on the `fast` tier**, free models first, with a daily cap; sync is **manual plus polling**, with no webhooks.

## Behavior

### Projects (§8.2 `Project` + `Repository`)

- In Phase 1 a project is **one local clone of one GitHub repository**. The spec's split into Project and several Repositories waits until something needs it; the event carries the repository fields, so the split stays possible.
- `navarch project add <clone> [--github owner/repo] [--name <name>]`. The command checks that the path is a git clone and reads `owner/repo` from its `origin` remote when `--github` is missing. It fails when the two disagree, as issue runs already do. It records `project.added`.
- `navarch project list` and `navarch project remove <id>`. Removing a project records `project.removed`. Its Inbox items leave the list, and its runs and their history stay.
- API: `GET /api/v1/projects`, `POST /api/v1/projects`, `DELETE /api/v1/projects/:id` (§9.1). Adding or removing needs the local token. A paired device can only list projects.
- Policy (rule 3): `project.add` and `project.remove` are allowed for the user only.
- `.navarch/project.yaml` in the repository keeps its role (autonomy, setup, verify, allowlist, protected paths), read at a run's base commit. The registry only says which repositories Navarch watches.
- The run start screens (New run on the phone, the desktop run form) offer registered projects first, then the repositories of earlier runs (`GET /api/v1/repos`, slice 7).

### Sync (WorkSource GitHub, §6.7.3)

- The GitHub client gains `listIssues(repo, { since, etag })`. The first sync of a project lists the open issues; later syncs list every issue updated since the newest `updated_at` seen (the project's cursor, open or closed), so closures are seen too. It leaves pull requests out, follows pagination up to 500 issues, and sends `If-None-Match`. A `304` costs no rate limit and changes nothing.
- A sync of a project:
  - records each new issue as `workitem.received` (the existing event, now with `project_id`);
  - records an issue whose title, body or labels changed as `workitem.received` again, which makes the item eligible for triage again;
  - records an item that is no longer open as `workitem.closed`;
  - ends with one `inbox.synced { project_id, new, changed, closed, not_modified }`.
- Triggers: `navarch sync [--project <id>]`, a *Sync* button in the Inbox (`POST /api/v1/inbox/sync`), and **polling** every `inbox.poll_minutes` (default 15, `0` turns it off). The poller runs one project at a time and backs off when GitHub answers 403/429 with a rate limit. A sync already running for a project is not started twice.
- Policy: `inbox.sync` is allowed for the user and for the system (the poller).
- Issue titles, bodies, labels and authors are **untrusted data** (T1). They are stored as data, shown as plain text, and delimited when given to a model.

### Triage outside a run

- Every item that is new or changed is triaged in the daemon by an **API model on the native client**, the same way the concierge works (ADR 0016). It runs without a worktree, without tools and without the repository. The prompt holds the issue, delimited and marked untrusted, plus the numbers and titles of the project's other open items so that the model can point out a duplicate.
- Model: `inbox.model` when set. Otherwise the router's `native` entries for profile `inbox`, tier `fast` by default, so free models come first. On a rate limit the next entry is tried at once, and an exhausted quota is skipped, as for any routed call. When no native entry is usable, items stay `new`, and the Inbox shows "Triage unavailable: no API model", with the hint to add one (for example `openrouter/<id>:free`).
- The model answers with a JSON object only, and the daemon validates it with Zod. Anything else is a failed triage (`workitem.triage_failed`), retried at the next sync, at most 3 times per version of the item. The fields are:

  | Field | Value |
  |---|---|
  | `kind` | `bug`, `feature`, `chore`, `docs`, `question` |
  | `complexity` | 1–5, same scale as the run triager (`Complexity: N`) |
  | `area` | ≤ 40 characters, e.g. `web`, `daemon/scheduler` |
  | `duplicate_of` | the number of another open item of the same project, or null; any other number is dropped |
  | `suggested_action` | `start_run` (with the Flow name `fix-issue`), `needs_info`, `duplicate`, `skip` |
  | `reason` | one sentence, ≤ 200 characters, shown as plain text |

- Each triage records `workitem.triaged { item_id, triage, model, cost_usd }`. The model's answer is untrusted as well: only the validated fields are kept, and `reason` is shown as plain text.
- **Daily cap**: `inbox.triage.daily_items` (default 50) and `inbox.triage.daily_usd` (default 0.50) per day, in the PC's local time. The Policy Engine (action `inbox.triage`, actor system) denies a triage once a cap is reached. Remaining items wait for the next day, and the Inbox shows "Daily triage limit reached (50 items)".
- A run started from an Inbox item still runs its own `triage` node, which sees the repository. The Inbox triage is only for sorting and choosing what to start.

### Cost estimate (§15.3, §19 idea 1)

- `estimated_cost_usd` of an item is the median cost of the last 20 finished `fix-issue` runs whose triage gave the same complexity, over every project. It is shown with the number of runs it comes from ("≈ $0.42 · 12 runs").
- With fewer than 3 such runs there is no estimate, and the Inbox shows "—" with the tooltip "Not enough finished runs with this complexity yet". No price is hardcoded.
- The multi-select total adds the known estimates and says how many items have none ("≈ $1.20 for 3 items, 1 without estimate").

### Inbox (§15.3)

- `/inbox` in the Web UI and `navarch inbox [--all] [--project <id>]` in the CLI.
- Columns: source (GitHub icon + `owner/repo#N`), title, kind, complexity, area, probable duplicate (a link to the other item), suggested action, estimated cost, plus the item's status.
- Item status, derived from events:

  | Status | When |
  |---|---|
  | `new` | received or changed, not triaged yet |
  | `triaged` | triaged |
  | `in_run` | a run of this item is active (linked by `run.created`'s `work_item`) |
  | `done` | that run ended with a PR (`pr_opened` or `done`) |
  | `dismissed` | dismissed by the user |
  | `closed` | closed on GitHub |

  These are WorkItem statuses (§8.2 `status`), not Run or Task states. §8.2 is updated with the list in this change.
- Default view: `new` and `triaged`, sorted by suggested action and then complexity. Filters: project, status, kind, complexity, suggested action. Text search covers the title.
- **Multi-select → "Start run with Flow X"** (§15.3): a dialog lists the items, the Flow (`fix-issue` by default, any published Flow that takes an issue), the budget per run, and the total estimate. *Start* calls `POST /api/v1/inbox/start { item_ids, flow, budget }`. That endpoint starts one issue run per item, in the project's clone, through the same path as `POST /api/v1/runs`, so each run's agents and side effects go through the Policy Engine as usual. An item with an active run, or closed, is refused. The answer lists the run ids and the per-item errors. The dialog states what will happen: "Starts 3 runs of fix-issue in nadezhdkov/nav. Each run asks before the plan and the PR (autonomy level 2)".
- *Dismiss* (`POST /api/v1/inbox/:id/dismiss { reason? }`, `navarch inbox dismiss <id>`) records `workitem.dismissed`. A change on GitHub does not bring the item back. *Restore* records `workitem.restored`.
- Item detail panel: the issue body as plain text (no HTML rendering, links shown but not followed automatically), labels, author, the triage with its model and reason, the duplicate, and the runs of this item.
- A paired phone may read the Inbox and start runs from it with the daemon's defaults (no Flow or budget of its own). Dismiss and sync are allowed too, and its New run screen may use registered projects. Project changes stay on the PC.
- The concierge gains one read tool, `list_inbox`, with no action.

### Desktop Home (§15.1) and agent quotas

- `/home` becomes the start page on desktop too. Today's phone cards stay as they are, and the desktop layout adds:
  - **Agent quotas**, the idea taken from Orca (see "References"): one row per adapter with its latest windows from `quota.observed` ("Claude Code · 5h 58% · week 41%, resets 14:00"). Each row has a bar plus the percentage in text. Exhausted windows get a warning icon and "exhausted until …". Adapters with no observation show "no data yet". Source: `GET /api/v1/quotas`, built from the latest observation per adapter, window and model prefix.
  - **Cost today** (sum of `cost_usd` of today's tasks) and the default budget.
  - **Inbox summary**: counts by suggested action and a link to `/inbox`.
  - **Alerts**: failed runs, budget stops and quota pauses of the last 24 hours, plus "Triage unavailable" and "Daily triage limit reached".
- The phone's Home gets the same quota rows in a compact form below the active runs.

### Sidebar: projects with their agents

- The desktop sidebar gets a **Projects** section, the second idea taken from Orca. Each registered project shows its name and count of active runs, and expands to its active runs and, under each run, its running agents with profile, adapter and age ("implementer · claude-code · 49m"). Each line is a link to the run or the Fleet panel. Status is shown by icon and text. The data comes from `GET /api/v1/projects` (with `active_runs`) and the Fleet (slice 6), live through the stream.

## API and contracts (contracts first, `packages/contracts`)

- `ProjectView { id, name, repo, path, added_at, active_runs, inbox: { new, triaged } }`. `ProjectCreateRequest { path, github?, name? }`.
- `WorkItemTriage { kind, complexity, area, duplicate_of, suggested_action, flow?, reason }`.
- `InboxItemView { id, project_id, source, repo, number, url, title, labels, author, status, triage?, triage_model?, estimate?: { usd, runs }, runs: string[], updated_at }`; the body only in `GET /api/v1/inbox/:id`.
- `GET /api/v1/inbox?project=&status=` returns `InboxItemView[]` plus `{ triage: { available, reason?, used_today, cap } }`.
- `POST /api/v1/inbox/sync { project_id? }` waits for the sync and returns `{ results: { project_id, new, changed, closed, not_modified, error? }[] }`.
- `POST /api/v1/inbox/start { item_ids, flow?, budget? }` returns `{ runs: { item_id, run_id }[], errors: { item_id, message }[] }`.
- `POST /api/v1/inbox/:id/dismiss|restore`.
- `GET /api/v1/quotas` returns `QuotaView[] { adapter, window, utilization?, resets_at?, exhausted, model_prefix?, observed_at }`.
- Item id: `wi_<source>_<owner>_<repo>_<number>`, stable, so a re-sync never duplicates an item.
- Events: `project.added { project_id, name, repo, path }`, `project.removed { project_id }`, `workitem.received` gains `project_id` (optional for old events), `workitem.closed`, `workitem.triaged`, `workitem.triage_failed { item_id, reason }`, `workitem.dismissed { item_id, reason? }`, `workitem.restored`, `inbox.synced`.
- Config (§14.1): `inbox: { poll_minutes: 15, model?: string, triage: { daily_items: 50, daily_usd: 0.5 } }` and `routing.profiles.inbox` (tier `fast`).

## Rules

- **Only the GitHub Integration talks to GitHub** (rule 5). Sync reads through it only. This slice adds no GitHub writes.
- **Only the Agent Runtime calls the Model Router** (rule 4). The triage service asks the runtime for its route, as the concierge does.
- **Every side effect through the Policy Engine** (rule 3): `project.add`, `project.remove`, `inbox.sync` and `inbox.triage`. Runs started from the Inbox take the same path as any other run.
- **Everything is an event** (rule 2): projects, items, triage and dismissals are events. The Inbox is a projection, and rebuilding it gives the same list.
- **Untrusted content** (T1): issue text never becomes instructions. It is delimited in the triage prompt, and the model's answer is reduced to validated enums, numbers and short plain-text strings.
- **Prices in configuration** (AGENTS.md): estimates come from observed costs only.

## Tests (no network, no real agent)

- Contracts: projects, items, triage, quota view and the new events.
- GitHub: `listIssues` against a fake GitHub server (pagination, pull requests left out, `ETag` → `304`, rate-limit 403 with `x-ratelimit-reset`).
- Sync: new, changed, closed and unchanged items give the right events; ids are stable across re-syncs; one sync per project at a time; polling interval and back-off on a fake clock.
- Triage: a fake OpenAI-compatible server. Covers valid JSON, invalid JSON (failed and retried at most 3 times per version), a `duplicate_of` outside the list (dropped), a rate limit (falls back to the next entry), no native model (items stay `new`, triage unavailable), and both daily caps (policy denial). The issue body is delimited in the request.
- Estimate: median over the last 20 runs of the same complexity, nothing below 3 runs, and the multi-select total.
- Inbox start: three items start three runs with the fake Claude in their project's clone; a policy denial on one is reported per item; items go to `in_run` and then `done`.
- CLI: `navarch project add|list|remove` (origin detection and mismatch), `navarch sync`, `navarch inbox`, `navarch inbox start|dismiss`.
- Web: the Inbox list, filters, multi-select dialog with the total estimate, the item panel rendering the body as text, desktop Home with quota rows (bar plus text), the sidebar projects tree, and complete locales.
- Visual check with `ctk shoot web`: a demo daemon with two projects, a fake GitHub with a dozen issues, and a fake model. Desktop 1440×900 in dark and light mode (Home, Inbox, the start dialog, the sidebar tree) and the phone at 390×844 (Home with quotas, Inbox).

## References

- Orca (github.com/stablyai/orca, MIT), reviewed on 2026-10-15. Two of its ideas are adopted here: the footer showing each provider's quota windows, and a sidebar grouped as project → branch → agents with their age. Two more are recorded in §19: a live chat with a run's agent, and one prompt sent to N agents with comparison and choice of the best. Navarch does not adopt the embedded terminal and browser, which would make it an IDE instead of an orchestrator.

## 🔴 Open

- The morning summary of §7.4 (scheduled triage plus a notification with a link to the Inbox) needs a scheduler for recurring jobs; it comes after this slice.
- Pull requests and CI failures as WorkItems (`kind: pr | ci_failure`); this slice has issues only.
- Label triggers (`navarch:go`) and webhooks through the relay.
- Several repositories per project, and budgets per project (`budget_daily`), which belong to the budgets slice.
