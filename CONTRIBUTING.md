# Contributing to Navarch

Thanks for your interest in Navarch! Issues, ideas and pull requests are all welcome. This page explains how to make them easy to act on.

Navarch is open source under the [MIT license](LICENSE) ([ADR 0018](docs/adr/0018-back-to-mit.md)). By opening a pull request you agree that your contribution is licensed under the same terms.

## Reporting a bug

Open an issue with:

- what you ran (the `navarch …` command, or the screen in the Web UI) and what you expected;
- what happened instead, with the relevant part of `navarch logs <run-id>` or the daemon log (`~/.navarch/navarchd.log`);
- your versions: the output of `make doctor` (Node, pnpm, git and the agent CLIs), and your OS.

**Remove secrets before you paste anything.** Navarch redacts secrets it knows about, but check tokens, API keys, private repository names and paths yourself.

## Reporting a security problem

Do not open a public issue for a vulnerability, a prompt-injection path or a way around the Policy Engine. Report it privately instead: see [`SECURITY.md`](SECURITY.md).

## Ideas and feature requests

Describe the problem you want solved, not only the solution. The product follows the spec ([`docs/navarch-especificacao.md`](docs/navarch-especificacao.md), in Portuguese) and its phased roadmap (§16), so an idea may be accepted but scheduled for a later phase. Decisions are recorded as ADRs in [`docs/adr/`](docs/adr).

**For anything larger than a small fix, open an issue first** so we can agree on the approach before you spend time on code.

## Pull requests

### Setup

You need Node ≥ 22.18, pnpm and git (`make doctor` checks them). Then:

```sh
make install     # pnpm install --frozen-lockfile
make verify      # typecheck + tests
```

Tests use fake agent CLIs and a fake model server, so they never reach a real agent, the network or your keychain, and cost nothing. `make ci` runs everything CI runs (it also needs `gitleaks` and `actionlint`). `make help` lists every target.

### What a good pull request looks like

- **One concern per pull request**, branched from `main`.
- **Tests with the code** (Vitest). Every agent adapter needs contract tests and a fake CLI; see "Adding an adapter" in [`AGENTS.md`](AGENTS.md).
- **Contracts first:** shared types are Zod schemas in `packages/contracts`; do not duplicate them in apps.
- **Sources run on Node without a build step** (type stripping): use erasable TypeScript only (no `enum`, `namespace` or constructor parameter properties) and import with `.ts` extensions. Only `apps/web` has a build.
- **Web UI changes:** every string goes through `vue-i18n` in all locales (`apps/web/src/locales/`), status is never shown by color alone, and a screenshot in the pull request helps review.
- **English** for code, comments, docs and commit messages, with [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` …).
- `make verify` passes locally.

### Rules that are not up for debate in a pull request

[`AGENTS.md`](AGENTS.md) lists the architecture and security rules: every side effect goes through the Policy Engine, state is derived from events, only the GitHub Integration talks to GitHub, secrets never reach logs or events, and merges are never automatic. A change that needs to bend one of them starts as an issue and, if accepted, an ADR.

### Review

The maintainer reviews every pull request and merges by hand. CI (typecheck, tests, audit, secret scan, workflow lint) must pass first.

## Working with coding agents

Contributions written with the help of coding agents are welcome; you remain responsible for what you submit. [`AGENTS.md`](AGENTS.md) (read by Codex, Copilot and others) and [`CLAUDE.md`](CLAUDE.md) hold the instructions agents follow in this repository, and `.claude/skills/` holds the project's skills.
