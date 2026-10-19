# Configuration

Navarch has two configuration files:

- `~/.navarch/config.yaml`: the daemon's settings. Every key is optional.
- `.navarch/project.yaml`, in each repository: what runs may do there. It is read at the run's base commit, never from the agent's worktree.

## Per repository: `.navarch/project.yaml`

```yaml
autonomy_level: 2          # 0–3, see Autonomy and approvals
setup:                     # prepares each worktree before agents start
  - uv sync --frozen
verify:                    # the checks after every implementation
  - name: lint
    run: make lint
  - name: test
    run: make test
  - name: e2e
    run: make e2e
    required: false        # reported, but does not fail the run
allowlist:                 # commands agents may run (` *` matches a prefix)
  - make lint
  - make test
  - make test *
  - uv run pytest *
protected_paths:           # changes here are flagged in reviews and PRs
  - .github/workflows/**
  - install.sh
```

Verify checks are required unless marked `required: false`.

## Daemon: `~/.navarch/config.yaml`

The most useful keys, with their defaults:

```yaml
daemon:
  host: 127.0.0.1
  port: 7420

autonomy_level: 2           # used when a repository sets none

scheduler:
  concurrency: 2            # agent tasks at once
  max_attempts: 3
  task_timeout_minutes: 60

budgets:
  default_run: 2            # USD, billed use only
  project_daily: null       # per registered project and local day
  global_monthly: 100
  alert_threshold: 0.8

inbox:
  poll_minutes: 15
  triage:
    daily_items: 50
    daily_usd: 0.5

ci_fix:
  auto: false               # true: start ci-fix on a newly failing pull request by itself
  daily_runs: 3             # most automatic starts per local day

knowledge:
  context:
    enabled: false          # true: give triage, plan and implement agents a compiled map of the code
    max_tokens: 4000

concierge:
  model: ollama/qwen2.5:7b  # an API model with tool calling

routing:
  enabled: true
  quota_reserve: 0.9        # agents above this share of a quota window go last
  rate_limit_cooldown_minutes: 30

notifications:
  quiet_hours: { start: "23:00", end: "07:00" }
```

Adapters can be turned on or off, and given a command path or a default model, under `adapters.<id>`. For example, set `adapters.opencode.command` when `~/.opencode/bin` is not on your `PATH`.

## Runtime state

Everything lives in `~/.navarch`: the event store, worktrees, logs, the device key and the push keys. Set `NAVARCH_HOME` to use another directory. Secrets are not there: they are in your OS keychain.
