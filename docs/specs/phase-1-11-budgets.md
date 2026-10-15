# Phase 1, slice 11: Budgets, quota-aware routing and token metrics

Status: draft · Branch: `feat/budgets` · Spec: §1.3 P3, §2.2 R2, §6.1.4, §6.4.1–6.4.2, §6.10.1, §9.2, §14.2, §15 · ADR: 0023 · Builds on: ADR 0005, 0013, 0014, 0020, 0021

The Cost Ledger of §6.1.4 grows from "a run has a budget" to budgets per run, per project and day and globally per month, with an alert at 80 % and an approval at 100 %. The Model Router gets step 3 of §6.4.2 (filter by remaining budget) and its first `observed` metrics, and a new **Usage** screen shows what was spent, in money and tokens, per model.

The difference from the spec's wording: most of Navarch's agents run on **subscription plans** (Claude Code Max, Codex/ChatGPT, Copilot, Google AI plans). Claude Code reports an API-equivalent cost for them ($1.66 in the Phase 0 go/no-go) that nobody is billed for. Budgets count only **billed** use; plan use is bounded by quotas and shown as an equivalent figure (decided by the user on 2026-10-15, ADR 0023).

## Behavior

### Billed and plan use

- Every usage record carries `billing`: `metered` (pay-as-you-go: the `native` adapter's providers, OpenCode, Claude Code with an API key) or `plan` (included in a subscription or free tier: Claude Code signed in to claude.ai, Codex, Copilot, gemini-cli, antigravity).
  - Claude Code: `plan` when its `system/init` event says `apiKeySource: "none"` (seen in real runs), `metered` otherwise. 🟢 `~/.navarch` logs, 6 init lines, all `"none"`.
  - OpenCode: `metered`; Zen's free models report cost 0, so they add nothing.
  - `native`: `metered`; Ollama reports cost 0.
  - The other CLIs: `plan`.
- Usage recorded before this slice has no `billing` and counts as `metered`, which is what it did until now.
- A run, a task and every total keep two sums: **cost** (billed, what budgets count) and **plan-equivalent cost** (what plan use would have cost on the API, where the agent reports it).

### Budgets

| Scope | Config default | Period | Set by |
|---|---|---|---|
| Run | `budgets.default_run` (2.00) | the run | `--budget` at start; `navarch budget set --run <id> <usd>` |
| Project, per day | `budgets.project_daily` (none) | local day of the PC | `navarch budget set --project <id> --daily <usd>\|none` |
| Global, per month | `budgets.global_monthly` (100.00) | local calendar month | `navarch budget set --monthly <usd>\|none` |

- A run counts towards its project (`FleetRun.project_id`, by repository path) and towards the global month. Runs outside registered projects have no project budget. Inbox triage (ADR 0021) counts towards the global month only; its own daily caps stay.
- Overrides set from the CLI or the Web UI are `budget.set` events and win over the config. `none` removes a project or global limit. Agents and paired devices cannot set budgets (ADR 0020 already refuses budgets from devices).
- **Alerts**: when a scope's billed cost reaches `budgets.alert_threshold` (0.8) of its limit, and again at 100 %, a `budget.threshold` event is recorded once per scope, period and threshold, and the Notifier sends a push ("80 % of the project budget for today used"; 100 % is critical).
- **At 100 %**: before an agent task starts, the Scheduler checks every scope of the run. If any is used up, the Policy Engine asks for approval (action `budget.exceed`) instead of today's silent block: the task goes `waiting_approval`, the run goes `budget_exceeded`, and the approval names the scope, used/limit and the task's expected cost. Approving lets that one task start; rejecting cancels it as any rejected approval does. Raising the budget is the other way out: after a `budget.set` the Scheduler retries tasks waiting on `budget.exceed` and withdraws approvals whose scope is no longer used up.
- A metered agent gets the smallest remaining amount of its scopes as `maxCost` (the `native` adapter already stops a task above it). Plan agents get no money cap.

### Router: budget and quota headroom (§6.4.2 steps 3 and 4)

- **Budget filter (step 3)**: a `metered` candidate whose *expected cost* is above the smallest remaining budget of the run's scopes is skipped ("expected $0.40, $0.25 left in the run"). Expected cost is the median billed cost of that catalog entry's succeeded tasks with the same profile in the last 30 days, needing at least 3 tasks; without enough history it is not filtered. `plan` candidates are never filtered by budget.
- **Quota headroom**: a candidate whose latest `quota.observed` window is at or above `routing.quota_reserve` (0.9) utilization, not yet reset, goes after the others in its tier ("quota 93 % used until 18:00, kept for later"). Exhausted quotas are still skipped as today.
- **Degraded**: a candidate with at least 4 tasks in the last 24 h and an error rate ≥ `routing.degraded_error_rate` (0.5), counting failures other than rate limits and cancellations, also goes after the others ("4 of 5 tasks failed in 24 h").
- Demotions keep the order among themselves; the lead's `prefer` (ADR 0022) and pinned runs are not affected by demotions but are by the budget filter only for a lead's preference. Every skip and demotion is in `model.routed` (`skipped`, and `reason`).

### Metrics (`observed`)

Computed from tasks and `model.call.completed` events, per catalog entry (adapter + model; tasks of pinned runs by adapter and model), per profile and in total, over a window (default 30 days):

- tasks, succeeded, success rate, error rate in the last 24 h;
- tokens in, out and cached (sums and median per task);
- billed cost, plan-equivalent cost, and **cost per succeeded task** (billed + equivalent, median);
- **tokens per succeeded task** (median), the measure of how much work a model gets out of its tokens;
- p50 task duration.

### Usage screen (`/usage`)

- Desktop sidebar entry **Usage**; on phones it is reached from Home.
- **Budgets**: the global month and each project's day as bars (used/limit, % as text, 80 % and 100 % marked by icon and text, not color alone), plus active runs near or over their budget. Editing a limit opens a dialog that states the scope, the old and new value and what it affects; not offered to paired devices.
- **Models**: a sortable table with the metrics above, filters by window (7/30 days) and profile, and billed vs. plan columns; an entry with too little history says so.
- **Quotas**: the agents' quota windows (today's Home card, moved here; Home keeps a summary and links to Usage).
- Home's "Cost today" becomes billed cost today (from the API, not summed in the browser) with the plan-equivalent figure under it.

## API and contracts (contracts first, `packages/contracts`)

- `UsageRecord.billing?: "metered" | "plan"`.
- Events: `budget.set { scope: "run"|"project_daily"|"global_monthly", target: string|null, usd: number|null, previous: number|null }`, `budget.threshold { scope, target, period, ratio: 0.8|1, used, limit }`.
- `RunSummary.plan_cost`, `TaskView.plan_cost`.
- `BudgetView { scope, target, label, period, limit: number|null, used, plan_equivalent, ratio|null, state: "ok"|"warning"|"exceeded" }`, `ModelMetricsView { id, adapter, model, provider, billing, profile|null, tasks, succeeded, success_rate, error_rate_24h, tokens_in, tokens_out, cached_tokens, median_tokens_per_success|null, cost, plan_cost, median_cost_per_success|null, p50_duration_ms|null }`, `UsageView { generated_at, window_days, today: {cost, plan_cost, tokens}, month: {…}, budgets: BudgetView[], models: ModelMetricsView[], quotas: QuotaView[] }`.
- `GET /api/v1/usage?days=7|30&profile=` (devices allowed), `GET /api/v1/budgets`, `PUT /api/v1/budgets { scope, target?, usd|null }` (user only).
- CLI: `navarch budget [show]`, `navarch budget set --monthly <usd|none> | --project <id> --daily <usd|none> | --run <id> <usd>`, `navarch usage [--days N] [--profile P] [--json]`.
- Concierge: read tool `show_usage`; no act tool for budgets (raising a budget is the user's).

## Rules

- Budgets count only `metered` cost. Plan use is limited by quotas (ADR 0005) and never blocks on money.
- Money limits, thresholds and windows live in configuration or `budget.set` events, never in code (spec §14).
- Periods use the PC's local time, as the Inbox caps do.
- The Policy Engine decides `budget.exceed`; the Scheduler only gives it the scopes' state. Approvals of `budget.exceed` show the scope, used/limit and the expected cost (spec §15 rule for sensitive actions).
- Metrics are computed on read from projections; no new projection is needed beyond budget overrides.
- Raising a budget will need re-authentication once WebAuthn exists (§6.10.3); until then it is a user action from the CLI or the desktop UI only.

## Tests (no network, no real agent)

- Adapters: Claude Code `plan`/`metered` from `apiKeySource`; the other adapters' `billing`.
- Projections: billed and plan sums per task and run; old usage without `billing` counts as billed.
- Budgets: scope resolution (run, project by path, global), local day and month boundaries, overrides and `none`, 80 % and 100 % `budget.threshold` once per period, approval at 100 % and the run in `budget_exceeded`, retry after `budget.set`.
- Router: budget filter with and without history, plan entries never filtered, quota reserve and degraded demotions, reasons in `model.routed`.
- Metrics: medians, success and error rates, windows and profiles.
- API and CLI: `/usage`, `/budgets` (device refused on PUT), `navarch budget`, `navarch usage`.
- Web: Usage view (bars with text, table sort, edit dialog hidden for devices), Home's cost card; screenshot check.

## 🔴 Open

- Copilot premium requests and Codex credits are plan use with their own limits; they are shown as quotas, not money.
- Cost is known only when a task ends (the adapters report usage at the end), so a long metered task can overshoot its `maxCost` except on `native`, which checks after every call.
- Expected cost uses medians of past tasks; there is no prediction from the prompt size yet.
- Gemini with a paid AI Studio key is metered but reports no cost; it is recorded as `plan` until the adapter can price its tokens from configuration.
