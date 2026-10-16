# Phase 2, slice 7: cost and quality panels

Status: implemented · Branch: `feat/cost-quality-panels` · Spec: §6.15 (cost panel, quality panel), §16 (Phase 2 scope), §17 (success metrics) · ADR: 0037 · Builds on: ADR 0023 (Cost Ledger, observed metrics)

The Usage screen already shows spend today and this month, budgets, metrics per agent and model, and quotas (slice 1-11). Spec §6.15 also asks for a **cost panel** "by day, project, model, agent profile" and a **quality panel** "success rate by profile and by model, accepted PR rate, rework". The rates of §17 that matter most, accepted PRs and rework, need something Navarch does not know yet: what happened to a PR after it was opened.

## Behavior

### PR outcomes

- Navarch follows every pull request it opened (`github.pr.opened`) until it is closed. The **PR watcher** (`apps/daemon/src/github/outcomes.ts`) reads each open one through the GitHub Integration every `inbox.poll_minutes` (15), and after `navarch sync` / `POST /api/v1/inbox/sync`. These are reads only, through the same token.
- When GitHub says a PR is closed, the watcher records `github.pr.closed` `{ repo, number, merged, closed_at, head_sha, commits_after }`:
  - `merged`: whether it was merged (any merge method), else it was closed without merging.
  - `commits_after`: the commits on the PR's head that came after the last commit Navarch pushed to that branch (`github.push`), from GitHub's compare (`ahead_by`). `0` means the PR was taken as Navarch opened it. Null when GitHub cannot compare (the head is gone).
- A PR is followed once: reopening it later is not tracked. A failed read (rate limit, network) is retried on the next poll. A PR that answers 404 three polls in a row (repository deleted, or out of the token's reach) is recorded as `github.pr.lost` and no longer followed.
- Projection `pull_requests` (one row per PR Navarch opened): run, repo, number, URL, branch, the last commit Navarch pushed, opened time, `state` (`open` | `merged` | `closed` | `gone`), closed time and `commits_after`.

### Cost panel

`MetricsView.cost`, over the last `days` local days (default 30, at most 365), from the Cost Ledger (`usage`, which includes Inbox triage). Every row keeps **billed** cost apart from the **plan-equivalent** cost (ADR 0023), with tokens:

- `days`: one row per local day of the window, oldest first, days without use included as zero.
- `projects`: per registered project (runs whose repository path is the project's clone), then per other repository path, then one row for use outside runs (Inbox triage). Each with its run count.
- `profiles`: per agent profile of the task that used it, and `null` for use outside runs.
- `models`: per model as the agent reported it, with the number of calls.
- `total` for the window.

### Quality panel

`MetricsView.quality`, over the same window:

- `profiles`: tasks, succeeded and success rate per profile, from finished agent attempts with the rules of the existing metrics: rate limits and cancellations count apart (`rate_limited`) and are left out of the rate.
- `models`: the existing `ModelMetricsView` rows (success rate, 24 h error rate, …).
- `pull_requests`, for PRs **opened** in the window:
  - `opened`, `open`, `merged`, `closed` (without merging), `gone`.
  - `acceptance_rate`: merged / (merged + closed); null without a closed one. Open PRs are not judged yet.
  - `accepted_as_is`: merged with `commits_after = 0`.
  - `rework`: closed PRs (merged or not) with `commits_after > 2`, the "> 2 rounds of adjustment" of §17, counting one commit as one round. `rework_rate` over closed PRs whose `commits_after` is known.
  - `cost_per_merged`: billed and plan-equivalent cost of the runs whose PR was merged, divided by the merged PRs; null without one (§17 "cost per accepted PR").
  - `recent`: the 20 latest, with run name, repo, number, URL, state, `commits_after`, times and the run's costs.

### Surfaces

- `GET /api/v1/metrics?days=` → `MetricsView`. Paired devices may read it, like `/api/v1/usage`.
- The Usage screen gets three tabs, **Overview** (today's screen), **Cost** and **Quality**, remembered per browser. Cost draws a daily bar chart of billed and plan-equivalent cost and ranked tables per project, profile and model. Quality shows the PR rates as tiles with their counts, success rate bars per profile and model, and the recent PRs list. The window (7, 30, 90 days) applies to both tabs.
- `navarch metrics [--days N] [--json]` prints both panels.
- The concierge's `show_usage` read tool also returns the PR rates.

## Out of scope

- Out-of-scope changes detected (§17), share of calls served by the `fast` tier or local models, and time from issue to draft PR: they need data the ledger does not have yet.
- Learning routing from the acceptance rate (§19, item 4).
- PRs opened before this slice: they have no row until their `github.pr.opened` is replayed, which happens when the projections are rebuilt on upgrade. They are then followed like new ones.

## 🔴 Open

- One commit is counted as one round of adjustment. A squash-before-merge workflow can hide rounds, and a reviewer who pushes many small commits inflates them. Review rounds (`CHANGES_REQUESTED` reviews) would be a second signal.
