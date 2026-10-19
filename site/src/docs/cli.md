# CLI reference

The `navarch` command (or `nav`) talks to the daemon. `navarch --help` prints this list; add `--json` to most commands for machine-readable output.

## Daemon and UI

| Command | What it does |
|---|---|
| `navarch daemon start\|stop\|status` | manage `navarchd` |
| `navarch web [--print]` | open the Web UI with a single-use sign-in code |
| `navarch remote status` | Tailscale and the phone's address |
| `navarch devices [revoke <id>]` | paired phones |

## Runs

| Command | What it does |
|---|---|
| `navarch run [options] <prompt>` | the `task` Flow: implement, verify, fix |
| `navarch run --issue owner/repo#N [--repo <clone>]` | the `fix-issue` Flow, ending in a draft PR |
| `navarch run --pr owner/repo#N [--flow review-pr\|ci-fix]` | review a pull request, or fix its failing checks |
| `navarch run list` | all runs |
| `navarch run show <run>` | one run: status, tasks, branches, worktrees, cost |
| `navarch run resume <run> [--follow]` | continue a paused run, or retry a failed one |
| `navarch logs <run> [-f] [--raw]` | a run's events, or the agent's raw output |
| `navarch cancel <run>` | cancel a run |
| `navarch pause <run>` | stop its agents; nothing starts until resumed |
| `navarch stop --all` | pause every active run |
| `navarch say <run> [--task <id>] [--now] <text>` | send an instruction to a run's agents |

Run options:

| Option | Meaning |
|---|---|
| `--repo <path>` | the local repository (default: the current directory) |
| `--adapter <id>`, `--model <id>` | pin one agent for the whole run |
| `--budget <usd>` | billed budget for this run |
| `--allow <cmd>` | allow one more command (repeatable, `"npm run *"` for a prefix) |
| `--setup <cmd>` | prepare the worktree first, such as `npm ci` (repeatable) |
| `--attach <file>` | a document every agent reads (up to 10 files, 200 kB) |
| `--flow <name>` | another Flow: `team`, `compete`, or one of yours |
| `--param <name=value>` | a parameter of the Flow (repeatable) |
| `--follow` | stream the run until it ends |

## Approvals

| Command | What it does |
|---|---|
| `navarch approvals [--all]` | pending (or all) approvals |
| `navarch approve <id> [--pick <choice>] [--reason <text>]` | approve, or pick another choice |
| `navarch reject <id> [--reason <text>]` | reject |

## Projects, repositories and the Inbox

| Command | What it does |
|---|---|
| `navarch project add <clone> [--github owner/name] [--name <name>]` | register a clone and watch its issues |
| `navarch project clone <owner/name>` | clone a repository the token reaches and register it |
| `navarch project list \| remove <id>` | registered projects |
| `navarch repos [--refresh]` | GitHub repositories the token reaches |
| `navarch map`, `navarch symbols <name>`, `navarch where <text>` `[--project <id>]` | explore the project of the current directory: languages, frameworks and entry points; where a symbol is defined (file and line); where a text appears. Read-only |
| `navarch sync [--project <id>]` | read new and changed issues now |
| `navarch inbox [--all] [--project <id>]` | triaged issues with estimates |
| `navarch inbox start <item>... [--flow <name>] [--budget <usd>]` | start one run per item |
| `navarch inbox dismiss <item> \| restore <item>` | hide or bring back an item |
| `navarch ci [--all]` | failing checks noticed on your projects' open pull requests |
| `navarch ci fix <failure> [--budget <usd>]` | start a `ci-fix` run on that pull request |
| `navarch ci dismiss <failure>` | stop showing a failure |

## Money, secrets and Flows

| Command | What it does |
|---|---|
| `navarch away [status]` | whether the approver is deciding for you, and what it did |
| `navarch away on [--for 4h] [--delegate plan,pr,start] [--max-complexity 1-5\|none] [--max-revisions 0-3] [--yes]` | hand approvals to the approver for a while |
| `navarch away off` | turn Away mode off |
| `navarch budget [show]` | billed use against each limit |
| `navarch budget set --monthly <usd\|none>` | the global monthly limit |
| `navarch budget set --project <id> --daily <usd\|none>` | a project's daily limit |
| `navarch budget set --run <run> <usd>` | one run's budget |
| `navarch usage [--days N] [--profile P]` | spend, tokens, success and cost per model |
| `navarch specs` | the specs written by `reverse-spec` runs and their share of confirmed (🟢) claims |
| `navarch metrics [--days N]` | cost by day, project, profile and model; success rates |
| `navarch secret set <name>` | store a secret in the OS keychain, read from stdin |
| `navarch secret status <name>` | whether a secret is set |
| `navarch flow list` | built-in and published Flows |
| `navarch flow show <name> [--version N] [--draft]` | a Flow's YAML |
| `navarch flow validate <file>` | check a Flow file against this daemon |

## Talk to it

| Command | What it does |
|---|---|
| `navarch` or `navarch chat` | a conversation with the [concierge](/docs/concierge) |
| `navarch ask <question>` | one question; proposals are shown, never run |

## Exit codes

`0` ok · `1` error · `2` usage · `3` daemon not running · `4` the run ended failed or cancelled.
