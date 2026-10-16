# Phase 2, slice 3: subflows, `review-pr` and `ci-fix`

Status: implemented · Branch: `feat/subflows` · Spec: §6.2.1 (`subflow`), §6.3.3 (profile `ci-fixer`), §6.7.4 (pull requests, CI), §7.3, §16, UC-08, UC-09 · ADR: 0032

A Flow can run another Flow as one of its nodes. Runs can start from a **pull request** as well as from an issue. Two new Flows use both: `review-pr` reviews a pull request and posts the review as comments, and `ci-fix` diagnoses a pull request's failing checks and either fixes them in a draft PR to that pull request's branch or comments with the evidence.

## Behavior

### The `subflow` node

- New node type `subflow` with these fields:
  - `flow`: the name of another Flow in `flows/`
  - `with`: values for the child Flow's params (plain values or expressions over the parent)
  - `inputs`: named inputs (plain values or expressions over the parent) added to every agent task of the child
  - `when`, as on every node
- When the daemon loads `flows/`, every `subflow` must name a loaded Flow, its `with` keys must be params of that Flow, and the child must not hold `team`, `compete` or `subflow` nodes (one level only). A broken reference stops the daemon from starting, as any invalid Flow does.
- A run keeps a copy of every child its Flow names (`RunFlow.subflows`), as it keeps its own Flow, so editing a child's YAML never changes a running run.
- The child runs inside the parent's run, in the parent's worktree, through the same `next()` step function:
  - Its tasks are the child's nodes with ids prefixed by the subflow node's id, `<id>.<child node>` (e.g. `fix.implement`, `fix.verify`), and so are its skipped nodes.
  - The child sees only its own tasks: `nodes.x` inside the child means the child's `x`. Its params are its defaults overridden by `with`.
  - The child's failure fails the parent with the reason prefixed `subflow <id>: …`. When the child is done, the parent goes on.
- The node's outputs are the outputs of the child's last succeeded agent task (`summary`, and anything it declared).
- A `when` that is false skips the whole node. Progress counts it as one step.
- The Web UI's TaskGraph draws a subflow as one node named after its child, with the state of its tasks. The node panel lists them.

### Agent outputs

- An agent may end its summary with a fenced `navarch-outputs` JSON object. Its string, number and boolean fields are added to the task's outputs (`summary` cannot be replaced), so later nodes and `when` conditions can read them, e.g. `nodes.diagnose.outputs.kind`. A missing or invalid block adds nothing.

### Runs on a pull request

- `CreateRunRequest.pull_request` (`owner/repo#N`; CLI `navarch run --pr owner/repo#N`, concierge `start_run` `pull_request`) starts a run on a pull request of the clone's `origin`. A run takes an issue or a pull request, never both. Without `--flow` it runs `review-pr`.
- At the start the GitHub Integration:
  - reads the pull request (title, body, author, labels, head and base branches and commits, fork or not, draft, state), and refuses one that is not open
  - fetches its head and base into the clone as `refs/navarch/pr/<N>/head` and `…/base`, with the token for that one command and no hooks
  - lists its failing checks on the head commit (at most 5, `failure` or `timed_out`) with the tail of each log (GitHub Actions job logs, else the check's own output), 6,000 characters each, redacted
- The run's base commit is the pull request's head, so every agent works on the pull request's code. **`.navarch/project.yaml` is read at the pull request's base commit, never at its head**: a pull request cannot change the verify commands, the allowlist or the setup commands that would run on it.
- The run prompt (`prPrompt`) carries everything as untrusted data (T1) in one delimited `<pull_request>` block: the metadata, the body, the diff from the base (`git diff base...head`, cut at 40,000 characters, with its `--stat`) and the failing checks. The operator's own instructions follow it as trusted text.
- The work item is recorded as `workitem.received` with `pull_request` details. `WorkItemRef.kind` is `pull_request`, so the UI shows it as a PR, and the Inbox never lists it.

### `review-pr` (UC-09)

- `flows/review-pr.yaml`: `review -> post_review`.
- `review` uses the new read-only profile `pr-reviewer`. It reviews the change in two axes, *Standards* (the repository's documented conventions) and *Correctness* (does the change do what its description says, safely), and ends with a fenced `navarch-review` JSON block:
  - `summary`
  - `verdict`: `comment`, `approve` or `request_changes` (the reviewer's opinion only)
  - `comments`: at most 30 entries of `path`, `line` (in the new version of the file) and `body`

  `parseReviewDraft` in `packages/contracts` validates it.
- `post_review` (github `pr.review`, policy action `github.pr.review`) posts **one** review on the reviewed head commit, always with the event `COMMENT`. Navarch never approves or requests changes on GitHub. The verdict is a line of the review's text.
  - Comments land as inline comments only on lines the diff shows on its right side. The others go into the review's text under "Other notes" as `path:line`.
  - Without a valid block, the reviewer's whole summary is the review's text.
  - Below autonomy level 3 the post waits for an approval that shows the review's text and every comment.
  - The review's text ends with a hidden `navarch:<run id>` marker. A retried post finds the earlier review instead of posting it twice.
- `review-pr` never pushes and never runs the project's commands. The reviewer has the read-only grant, and setup commands run only for editing profiles. It also works on pull requests from forks.

### `ci-fix` (UC-08, §7.3)

- `flows/ci-fix.yaml`: `diagnose -> fix -> review -> open_pr -> comment`, param `max_fix_iterations` (2).
- Starting it needs a pull request with at least one failing check, whose head branch is in the same repository (`invalid_request` otherwise). A fork's branch cannot be the base of Navarch's PR, and its code would run in verification.
- `diagnose` uses the new read-only profile `ci-fixer`. It reads the failing checks and the diff, classifies the failure as `code`, `flaky` or `infra` with evidence, and declares `kind` in a `navarch-outputs` block.
- When `kind == 'code'`:
  - `fix`: a subflow of `task` (the implement ⇄ verify loop) with the diagnosis as input
  - `review`: the usual `reviewer`
  - `open_pr`: a draft PR from the run's branch `navarch/<run>/ci-fix` **to the pull request's head branch**. Its title is `fix(ci): <title>`, and its body says which checks of which pull request it fixes.
- Otherwise `comment` (github `pr.comment`, policy action `github.pr.comment`) posts the diagnosis on the pull request as one comment, idempotent with the same marker, and changes no code. A missing or invalid `kind` counts as "not code": the safe side.
- The start makes the same push check as any run that ends in a PR (go/no-go finding F5).

### Policy

- `github.pr.review` and `github.pr.comment` are allowed at autonomy level 3 and need an approval below it, like `github.pr.create`. The approval shows the text that will be posted.

## Out of scope

- Starting these Flows from GitHub events (`check_run` failures, `/navarch review` comments) and webhooks: no triggers yet. Runs start from the CLI, the API and the concierge.
- The escalation of `ci-fixer` from tier `standard` to `expert` on a retry (§6.3.3).
- Flaky-test reruns: the comment only suggests one.
- Nested subflows, and teams or compete nodes inside a subflow.
- Generic `parallel`/`join` nodes and Flow Studio.

## Acceptance

- A Flow with a subflow runs the child's nodes as prefixed tasks. Child expressions see only the child, `with` sets its params, `inputs` reach its agents, and its failure fails the parent.
- Loading a Flow whose subflow names an unknown Flow, an unknown param or a nested composite node fails with a clear message.
- `navarch run --pr o/r#N` reviews the pull request and, after approval below level 3, posts one `COMMENT` review with inline comments on diff lines only. A retry does not post twice.
- `navarch run --flow ci-fix --pr o/r#N` on a code failure opens a draft PR to the pull request's branch with the fix verified. On a flaky or infra failure it comments instead and changes nothing.
- The project config of a pull-request run comes from the pull request's base commit.
