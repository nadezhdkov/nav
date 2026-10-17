# Phase 2, slice 8: Away mode and the approver

Status: implemented · Branch: `feat/away-mode` · Spec: §6.10 (Policy and approvals), §11 (autonomy), §7.4 (what happens while the user is away) · ADR: 0039

When the user works elsewhere, runs wait for a plan or PR approval nobody has time to give. Away mode hands those approvals to an **approver agent**, on the user's explicit, time-boxed yes, and records everything it decides.

## Behavior

### Turning it on and off

- `PUT /api/v1/away` `{ enabled: true, confirm: true, delegate, minutes, max_complexity, max_revisions }`:
  - `delegate`: any of `plan` (the plan approval), `pr` (opening the draft PR), `start` (starting agents, autonomy 0 and 1). Default `plan, pr`.
  - `minutes`: 5 to 10,080 (7 days) or `null` for no limit. Default 240.
  - `max_complexity`: 1–5 or `null`. A run whose triage is above it is left to the user. Default 3.
  - `max_revisions`: 0–3, how often one plan may be sent back. Default 2.
  - Without `confirm: true` the request is refused (400).
- `{ enabled: false }` turns it off. `away.enabled|disabled` are events; the mode turns itself off at `until` (`reason: "expired"`).
- Policy action `away.set` is allowed for the user from the desktop or the CLI. Agents and paired phones are denied. `GET /api/v1/away` is open to phones, which show the banner.
- CLI: `navarch away [status]`, `navarch away on [--for 4h|90m|2d|none] [--delegate plan,pr,start] [--max-complexity 1-5|none] [--max-revisions 0-3] [--yes]`, `navarch away off`. `on` prints the warning and asks, or needs `--yes` without a terminal.
- Web UI: `/away` (desktop sidebar), with the warning, the options, an "I understand" checkbox and the log of what the approver did. A banner shows on every screen while it is on, with the counts and a link.

### What the approver does

- When an approval is requested (and for those already waiting when the mode is turned on, or after a restart), if its kind is handed over, the daemon builds a dossier and asks the approver model once. Approvals are handled one at a time.
- Rules that never reach a model: complexity above the limit, and a PR whose verification did not pass, are left to the user with the reason.
- The model answers `approve`, `revise` (with feedback; only for plans and only below `max_revisions`) or `escalate`. A `revise` it may not give, or without feedback, becomes `escalate`.
- `approve`: `approval.decided` as `{ kind: "agent", profile: "approver", adapter: "native", model }`.
- `revise`: `approval.decided` with `revise: true` and the feedback as `reason`. The approval node ends with `outputs { approved: false, revise: true, feedback }`. The engine starts the node before it again with iteration + 1 and the inputs `revision_feedback` and `previous_plan`, and then the approval node again for the new plan. After 3 revisions the run fails on a flow decision, which the user can resume.
- `escalate` (or no answer): the approval stays pending, `away.reviewed` says why, and the user's phone gets the approval notification that was held back. An approval is reviewed once.
- Every verdict is `away.reviewed` `{ approval_id, subject, verdict, reason, model, cost_usd }`.

### Never delegated

Merges, deploys and auto-merge (not agents' to decide at all), budget approvals and raising budgets, PR reviews and comments on other people's PRs, compete picks, anything the user did not tick.

## Tests

- Flow engine: a revised approval reruns the planner with the feedback and then asks again; the third revision fails; a plain approval is unchanged (`packages/flow-engine/test/revise.test.ts`).
- Policy: `away.set` only by the user off a phone; `approval.delegate` only for the approver, active and handed over.
- Daemon (`apps/daemon/test/away.test.ts`), with a fake model server: confirm is required; plan and PR approved to a finished run with no pending approval; a plan sent back, redone with the feedback in the planner prompt and approved; escalation leaves the approval pending and answerable; nothing happens while off or for kinds not handed over; the prompt marks everything untrusted, and answers are cut down.
- CLI formatting.

## Not yet

Stacking runs on open PR branches so the fleet does not wait for merges; a morning summary push; counting the approver's cost against budgets; per-project settings.
