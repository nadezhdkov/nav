# Flow Studio go/no-go — 2026-10-16

**Criterion (spec §16, Phase 2):** create a new Flow only in the UI and run it without editing YAML. The acceptance in [phase-2-04](../specs/phase-2-04-flow-studio.md) states it more precisely: a Flow created only through the Studio (library, canvas, properties, never the YAML view) validates, publishes as v1 and runs from New run like a built-in Flow. It also asks that publishing v2 while a run of v1 is going leaves that run on v1.

**Verdict: met, with six findings.**
- `plan-and-pr` was built and published through the Web UI alone, with clicks driven by Playwright. Its YAML view was never opened.
- It ran twice on [vectr-sandbox](https://github.com/nadezhdkov/vectr-sandbox):
  - Once from New run, from a prompt. That run finished without a PR.
  - Once from issue #5, which ended in the draft PR [vectr-sandbox#9](https://github.com/nadezhdkov/vectr-sandbox/pull/9).
- A version published while a run was going did not change that run.
- The first attempt from New run was refused (F1). The Flow needed a v2 with a condition on its PR node, also made in the Studio, before a prompt run could use it.

## Setup

- The daemon ran from `feat/kilo-adapter` (6e6d160, which is `main` after #48 plus the Kilo adapter) with the real home `~/.vectr`, on port 7420. The autonomy level was the default 2, so plan and PR approvals wait for a human.
- The Web UI was driven by Playwright (Chromium, 1440×900) with single-use sign-in codes from `navarch web --print`. The scripts used only the library, the canvas and the properties panel:
  - clicks on library items
  - selecting nodes
  - typing into the properties form fields (Id, Profile, Inputs, Show to the approver, Run only when, Most iterations)
  - Save draft, Simulate, Publish
- The YAML view of `plan-and-pr` was never opened. A first exploratory Flow, `plan-and-do`, was used to learn the controls; its YAML view was opened once, read-only. It was then discarded and is not counted.
- Routing was left to the Model Router (no `--adapter`).

## What was built

`plan-and-pr`: planner → approval gate (shows the plan) → loop of implementer (inputs `plan`, `previous_failures`) ⇄ `verification.run`, at most 3 → reviewer (inputs `plan`, `implementation`) → GitHub `pr.create` (draft).

| Version | Change, made in the Studio | Diff shown at Publish |
|---|---|---|
| v1 | the Flow above | the whole document |
| v2 | `open_pr` "Run only when" `${{ project.work_item }}` | +1 line |
| v3 | the loop's "Most iterations" 3 → 2 | +1 −1 |

The simulation of v1 with `verify` failing twice showed three implement ⇄ verify iterations, then review and PR ("The run would finish and open a PR"). For v2 without an issue, it showed `open_pr` "skipped: when project.work_item is false".

## Runs

| Run | Started from | Flow version recorded | Agents (plan · implement · review) | Result | Billed | Plan-equivalent |
|---|---|---|---|---|---|---|
| `honest-launch` | New run, a prompt (add `docs/USAGE.md` and link it) | `studio` v2 | claude-code · claude-code · copilot | done in 2 min 19 s, `open_pr` skipped, nothing pushed | $0 | $0.28 |
| `gentle-drakkar` | issue vectr-sandbox#5 (`navarch inbox start … --flow plan-and-pr`) | `studio` v3 | claude-code · claude-code · copilot | draft PR [#9](https://github.com/nadezhdkov/vectr-sandbox/pull/9), `notes.txt` +1 | $0 | $0.23 |

- **Versions:** v3 was published while `honest-launch` was planning. Its `run.created` still says v2, and its loop keeps `max_iterations: 3`. `gentle-drakkar`, started after v3 was published, says v3, with `max_iterations: 2`. This matches the acceptance criterion.
- **Approvals:** both plans and the PR were approved on the Approvals screen of the Web UI, after reading the plan and the diff.
- **Writes:** `honest-launch` recorded no `github.*` event. `gentle-drakkar` recorded one `github.push` and one `github.pr.opened`, both on `navarch/run_01M534P98S5W54FS6805F390ME/plan-and-pr`, and the PR is a draft. `main` of vectr-sandbox did not change.
- The reviewer ran on a provider other than the implementer's in both runs.

## Findings

| # | Finding | Fix |
|---|---|---|
| F1 | New run offered `plan-and-pr` v1 and refused it only after Start: "flow opens a PR and needs an issue". The rule dates from slice 2: a PR node without `when` needs an issue. The UI did not know a Flow's requirement. | `FlowSummary.needs` (`prompt`, `issue`, `pull_request`) comes from `flowNeeds` in `packages/flow-engine`, which the orchestrator now uses too. New run shows a Flow that needs an issue or a pull request as disabled, with the reason. |
| F2 | `navarch run show` printed `flow plan-and-pr` without the version. The run page shows `· v2`. | It prints `plan-and-pr v3 (Flow Studio)`. |
| F3 | The Inbox start dialog could start only `fix-issue` or a team. Starting an issue with a Studio Flow took the CLI (`--flow`). | The dialog offers fix-issue, team and every published Studio Flow that takes an issue. |
| F4 | Approval cards named the run by id (`run_01M5…`), not by codename (ADR 0027). | They show the codename. |
| F5 | A Studio Flow that was never published could not be deleted in the UI: "Discard draft" appeared only once a version existed. The API already allowed it. | "Delete flow" appears for an unpublished Flow, then goes back to `/flows`. |
| F6 | After the API discarded an unpublished Flow's draft, the Flow stayed in `navarch flow list` as `unpublished -`, an empty row. | The projection deletes the row, and the store ignores rows left by older daemons. |
| F7 | The PR body did not say which Flow, or which version of it, produced the change. | The PR's "Run" section names the Flow, and a Studio Flow's version. |

Fixed in `fix/flow-studio-go-no-go`, with tests for each finding except the New run change (F1's UI half), which was checked on a screenshot.

## Also observed

- The implementer of `gentle-drakkar` wrote in the PR body that it could not run the verify step because only git commands are allowed. Verification still ran as the `verify` node and passed. The prompt could say that Navarch runs the checks after the agent; this is not a defect.
- The same daemon ran a `task` run pinned to the new `kilo` adapter (`misty-navette`, PR #49): the implementer finished in 47 s for $0 and the check passed.
