# Getting started

This guide installs Navarch from source, starts its daemon, and runs your first task on a local repository. It takes a few minutes.

## Requirements

- **Node.js 22.18 or later**, **pnpm** and **git**.
- **At least one agent CLI**, installed and signed in. Claude Code is the default; see [Agents](/docs/agents) for the others.

## Install

```sh
git clone https://github.com/nadezhdkov/nav.git navarch
cd navarch
make install      # pnpm install
make web-build    # build the Web UI that the daemon serves
```

Until packaged releases exist, run the CLI from the checkout. An alias keeps it short:

```sh
alias navarch="node $PWD/apps/cli/src/main.ts"
```

Add the alias to your shell profile to keep it. `make cli ARGS="…"` runs the same commands from the checkout.

## Start the daemon

```sh
navarch daemon start
navarch daemon status
```

The daemon, `navarchd`, keeps its state in `~/.navarch` (set `NAVARCH_HOME` to use another directory). It listens only on `127.0.0.1`, port 7420 by default.

## Your first run

Give an agent a task in a repository on your machine:

```sh
navarch run --repo ~/code/my-repo --budget 1 --follow "Fix the failing date parser test"
```

What happens:

- Navarch creates a branch `navarch/<run-id>/task` and a worktree for it under `~/.navarch/worktrees/`. **Your checkout is never touched.**
- The agent implements the prompt. Then your project's checks run, and failures loop back to the agent up to three times.
- `--budget 1` caps billed spend for this run at one dollar. `--follow` streams the run's progress.

Every run gets a codename such as `brave-frigate`, which you can type wherever a run id goes:

```sh
navarch run list
navarch run show brave-frigate
navarch logs brave-frigate -f
```

## Let the agent run your checks

Agents may only run commands your project allows. Add a `.navarch/project.yaml` to the repository:

```yaml
autonomy_level: 2
setup:
  - npm ci
verify:
  - name: test
    run: npm test
allowlist:
  - npm test
  - npm run *
```

Commit it: Navarch reads it **at the run's base commit**, so an agent cannot change its own rules. See [Configuration](/docs/configuration) for every key.

## Open the Web UI

```sh
navarch web
```

It opens the UI with a single-use sign-in code. Watch the run's graph, its timeline and the agent's live diff.

## Next

- Run on a real GitHub issue: [Your first issue run](/docs/first-issue-run).
- Learn what a run is made of: [How it works](/docs/how-it-works).
