# Flows

A Flow defines what a run does. Navarch ships with six built-in Flows, and you can build your own in Flow Studio.

## Built-in Flows

| Flow | Starts from | What it does |
|---|---|---|
| `fix-issue` | an issue | triage → plan → approve plan → implement ⇄ verify → review → draft PR |
| `task` | a prompt | implement ⇄ verify, no pull request |
| `team` | an issue or a prompt | a lead agent splits the work and delegates members ([Team mode](/docs/team-and-compete)) |
| `compete` | an issue or a prompt | the same task for 2–5 agents, a judge ranks them, you pick ([Compete mode](/docs/team-and-compete)) |
| `review-pr` | a pull request | a read-only reviewer drafts one review, posted as a comment after approval |
| `ci-fix` | a pull request with failing checks | diagnoses the failure; fixes code failures in a draft PR into the branch, or comments on flaky and infra ones |
| `reverse-spec` | a prompt naming the scope | reads the code and writes specs to `.navarch/specs/` on the run's branch, each claim marked 🟢 confirmed, 🟡 inferred or 🔴 gap |

Pick one with `--flow`:

```sh
navarch run --flow team --repo ~/code/app "Add dark mode to the settings page"
navarch run --flow compete --budget 3 --repo ~/code/app "Speed up the search index build"
navarch run --pr owner/repo#17                 # review-pr
navarch run --pr owner/repo#17 --flow ci-fix
```

A run may set its Flow's parameters with `--param name=value`, for example `--param competitors=4`.

### Specs from the code

```bash
navarch run --flow reverse-spec "document the packages/runner module"
navarch specs
```

The agent describes what the code does as claims, each with a confidence and its evidence: the file, the line and a quote of the code. Navarch checks every quote against the code before writing anything. A claim the agent calls 🟢 keeps it only when the file, line and quote are really there; otherwise it becomes 🟡 and the spec says why. The files (one per component, an index and a coverage summary) are committed on the run's branch, `navarch/<run>/reverse-spec`, and nothing is pushed or changed in your clone. `navarch specs` shows each run's share of 🟢 claims. If the agent's answer is unusable, it is told what was wrong and tries once more.

### Failing checks are noticed for you

On the same schedule as the Inbox (and on `navarch sync`), Navarch looks at the open pull requests of your projects. When a pull request's checks have all finished and some failed, it records the failure once per commit and sends a push notification. Home shows them in a **CI failures** card with **Fix it** and **Dismiss** buttons (on your phone you see the list and a link to the pull request); `navarch ci` lists them, and `navarch ci fix <failure>` starts `ci-fix` on the pull request.

It skips pull requests from forks, Navarch's own `ci-fix` branches and commits whose checks are still running. By default it only tells you. To let it start the run itself, set `ci_fix.auto: true`; it then starts at most `ci_fix.daily_runs` (3) a day, and the run still asks for the usual approvals and respects the budgets.

## What a Flow looks like

This is the `task` Flow, in full:

```yaml
apiVersion: navarch/v1
kind: Flow
metadata:
  name: task
  description: Implement a prompt in an isolated worktree, then verify and fix until the checks pass.
params:
  max_fix_iterations: { type: int, default: 3 }

nodes:
  - id: implement_loop
    type: loop
    max_iterations: ${{ params.max_fix_iterations }}
    until: ${{ nodes.verify.outputs.passed }}
    body:
      - id: implement
        type: agent
        profile: implementer
        inputs:
          previous_failures: ${{ nodes.verify.outputs.blocking_failures }}
      - id: verify
        type: action
        uses: verification.run

edges:
  - implement_loop
```

Node types include `agent`, `action` (such as `verification.run`), `approval`, `github` (such as `pr.create`), `loop`, `team`, `compete` and `subflow`. A node can run conditionally with `when:`, and agents can pass values to later nodes through their outputs.

## Flow Studio

Open **Flows** in the Web UI (desktop) to build your own:

- Start from scratch, or **duplicate** a built-in Flow.
- Drag nodes from the library onto the canvas, connect them by dragging a node's right handle, and edit each node in its properties form. The **YAML view** shows the same document, and visual edits keep your comments and formatting.
- The daemon **validates** the document as you type. It reports disconnected nodes, cycles outside a loop, unknown profiles or adapters, and references to later nodes, each with its node and line.
- **Simulate** runs the Flow engine over made-up outcomes per node, so you can see which path a run would take.
- **Publish** creates a new version. Drafts never run.

Run a published Flow by name, from the CLI or from **Your flows** in New run:

```sh
navarch run --flow my-release-notes --repo ~/code/app "Draft the notes for 2.4"
```

A built-in Flow with the same name takes precedence. The run page shows which version ran (`name · vN`).

From the terminal, `navarch flow list`, `navarch flow show <name>` and `navarch flow validate <file>` work with Flows too.
