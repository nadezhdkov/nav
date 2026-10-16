# Phase 1 go/no-go — 2026-10-15

**Criteria (spec §16, Phase 1):**

1. At least 50 % of the PRs on issues of complexity ≤ 2 are accepted with at most small fixes.
2. No write outside `navarch/*` branches in 100 % of the runs.
3. The average cost per run stays within the budget.
4. An approval is given from the phone from outside the LAN.

**Verdict: met.** Six `fix-issue` runs went from a GitHub issue to a draft PR. The issues were one in a sandbox repository and five real ones in claude-toolkit, picked up and triaged by the Inbox. The user accepted all five claude-toolkit PRs as they were, and three of them come from issues of complexity 2. Every push and PR went to a `navarch/*` branch. No run used billed money: plan use averaged $0.47 per run against a $2 run budget. The plan and PR approvals of the five claude-toolkit runs were given from the phone on mobile data, with Wi-Fi off.

## Setup

- The daemon ran from `main` (15ab729 after the retry fix in #30), with home `~/.vectr`, port 7420, `budgets.default_run: 2` and `budgets.global_monthly: 100`. Autonomy level is the default, so the plan and the PR both wait for approval.
- Phone access used `tailscale serve` to the tailnet HTTPS name. The phone (a Redmi Note 14) was paired from the Settings QR code as `dev_01M4ZVTEPG…`.
- Two registered projects: [vectr-sandbox](https://github.com/nadezhdkov/vectr-sandbox) and [claude-toolkit](https://github.com/nadezhdkov/claude-toolkit). Before the runs, claude-toolkit got a `.navarch/project.yaml` (setup `uv sync`, verify `make lint` and `make test`, an allowlist) through nadezhdkov/claude-toolkit#44, merged by the user.
- The issues were written by us with the user's approval: claude-toolkit #45–#49 and vectr-sandbox #7. The Inbox triaged them with `ollama/qwen2.5:7b` (`inbox.model`) and the runs were started from the Inbox (`navarch inbox start`).
- Routing was left to the Model Router (no `--adapter`), with grok first for the `fast` tier.

## Results

Complexity is the value from the run's triager (`Complexity:` in its result), not the value from the Inbox triage.

| Issue | Run | Complexity | Triage · plan · implement · review | PR | User's verdict |
|---|---|---|---|---|---|
| vectr-sandbox#7 Add a CHANGELOG.md | `…983Q6` | 1 | grok · grok · copilot · claude-code | [vectr-sandbox#8](https://github.com/nadezhdkov/vectr-sandbox/pull/8) | sandbox, not judged |
| claude-toolkit#45 doctor: a path that is not a directory is reported as ok | `…NYC5` | 2 | copilot · copilot · copilot · claude-code | [#51](https://github.com/nadezhdkov/claude-toolkit/pull/51) | accepted as is |
| claude-toolkit#46 map: an empty `--uses` value prints the whole map | `…KH55` | 2 | copilot · copilot · copilot · claude-code | [#52](https://github.com/nadezhdkov/claude-toolkit/pull/52) | accepted as is |
| claude-toolkit#49 doctor: a pre-release tool passes a pin on its final release | `…XTXX` | 2 | copilot · copilot · copilot · claude-code | [#50](https://github.com/nadezhdkov/claude-toolkit/pull/50) | accepted as is |
| claude-toolkit#47 guard-destructive: catch `xargs rm -rf` and `find -delete` | `…XCQ` | 3 | copilot · claude-code · claude-code · copilot | [#54](https://github.com/nadezhdkov/claude-toolkit/pull/54) | accepted, merged |
| claude-toolkit#48 pep440: pre-, post- and dev-release versions | `…JA3` | 3 | copilot · claude-code · claude-code · copilot | [#53](https://github.com/nadezhdkov/claude-toolkit/pull/53) | accepted, merged |

The routing behaved as slice 3 and slice 11 describe. Complexity ≤ 2 sent the planner and the implementer to the `fast` tier, while complexity 3 sent them to claude-code. The reviewer always ran on a provider other than the implementer's.

**Criterion 1 (accepted PRs, complexity ≤ 2): 3 of 3, 100 %.** Each of the three real PRs was accepted without changes. The complexity 3 PRs were accepted too. The only request was to name the agents behind the plan, the change and the review in the PR body, which became nav#32. The sandbox PR is a smoke test and is left out of the count.

**Criterion 2 (writes only on `navarch/*`): 6 of 6 runs.** The event store has six `github.push` and six `github.pr.opened` events since the start of the campaign. Each one is on `navarch/<run>/fix-issue`, and each PR is a draft. On GitHub, the only new branches are those six. `main` in both repositories changed only through the user's own merges (#44, #53, #54) and the user's config commits to the sandbox on 2026-10-14. The older `vectr/…` branch in the sandbox predates the rename and comes from Phase 0.

**Criterion 3 (cost within budget): met.** All six runs ran on subscription plans (grok, copilot, and claude-code signed in to claude.ai), so each run's billed cost is $0.00 against its $2 budget. The API-equivalent plan cost was $2.85 for the six runs:

| Run | Plan-equivalent |
|---|---|
| vectr-sandbox#7 | $0.24 |
| claude-toolkit#45 | $0.19 |
| claude-toolkit#46 | $0.25 |
| claude-toolkit#47 | $1.16 |
| claude-toolkit#48 | $0.64 |
| claude-toolkit#49 | $0.37 |
| **Average** | **$0.47** |

Even when the plan-equivalent cost is counted as if it were billed, every run stayed under $2. The month's billed total is $0.16 of $100, all of it from an earlier smoke run. The claude-code five-hour window reached 95 % during the campaign, which is the limit that matters in practice on plans.

**Criterion 4 (phone approval from outside the LAN): met.** Ten approvals on the five claude-toolkit runs were recorded with actor `via: mobile` and device `dev_01M4ZVTEPG…`: five plan approvals at 19:44:37–19:44:48 UTC and five PR approvals at 19:50–19:52 UTC. Wi-Fi was off on the phone. Before and after the approvals, `tailscale status` showed the phone's route as `direct 179.240.17.229`, the carrier's public address. The two earlier approvals on the sandbox run (19:16 and 19:18 UTC) went over the LAN (`via 192.168.0.4`), so they do not count for this criterion.

**Retry:** the five claude-toolkit runs first failed at `open_pr` with a push 403, because the PAT had no write access to claude-toolkit (F5). The work stayed committed on each local `navarch/*` branch. After the user widened the PAT and #30 (ADR 0025) was merged, `navarch run resume` brought each run back to its failed step. All five opened their PRs without new approvals and without rerunning the agents.

## Findings

| # | Finding | Effect | Status |
|---|---|---|---|
| F1 | Without a native model, the Inbox triage reports grok, copilot and claude-code as "rate limited". They are only excluded because they are not native (`apps/daemon/src/routing/native-models.ts`). | A misleading reason; it looked like a quota problem | fixed in #29 |
| F2 | When the phone cannot reach the daemon (Tailscale offline, killed by Android battery saving), the app shows "nothing waiting for you" instead of an offline state. | The user thinks there is nothing to approve | open |
| F3 | A checkout with stale `node_modules` keeps the daemon from starting (`@navarch/adapter-copilot` not found), and nothing points to `make install`. | The daemon failed to start after a pull | open |
| F4 | Grok's free limit ("You've reached your free Grok Build usage limit for now") gives no reset time, so grok is never marked as exhausted. | 12 attempts: every `fast` task tried grok first and fell back to copilot, about 4 s each | open: assume a backoff window when no `retry_at` is given |
| F5 | GitHub write access is not checked before a run starts. A 403 shows only at `open_pr`, after all the agent work is done. | All five claude-toolkit runs failed at the last step | retry fixed in #30; open: a push preflight at run start or `project add` |
| F6 | `navarch usage` and `/usage` show grok with 14 tasks at 100 % OK and no errors, although the `attempts` table has 12 grok attempts that failed as `rate_limited` and fell back. | The degraded-provider rule (slice 11) cannot see grok's failures | open |

Follow-ups outside the criteria: run codenames (nav#33, ADR 0027), fetching a managed clone before a run (ADR 0026), and a ctk issue where the affected-tests hook runs vitest without the root config.

**Go for Phase 2.** F4–F6 should be fixed first, because they affect routing and the cost of every run. F2 and F3 are UX issues and do not block Phase 2.
