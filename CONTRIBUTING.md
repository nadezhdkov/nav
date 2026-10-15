# Contributing to Navarch

Thanks for your interest in Navarch. Please read this before you open an issue or a pull request.

## What we accept today

Navarch is **source-available** under the [PolyForm Noncommercial License 1.0.0](LICENSE), not open source ([ADR 0010](docs/adr/0010-polyform-noncommercial-license.md)). The author keeps the right to license it commercially, and that needs a contributor agreement that does not exist yet. Until it does:

- **Pull requests from outside the project are not accepted.** They will be closed without review, however good they are. Please do not send code, patches or diffs in issues either.
- **Issues are welcome:** bug reports, questions, and ideas described in your own words.

This section will change once there is a contributor agreement.

## Reporting a bug

Open an issue with:

- what you ran (the `navarch …` command, or the screen in the Web UI) and what you expected;
- what happened instead, with the relevant part of `navarch logs <run-id>` or the daemon log (`~/.navarch/navarchd.log`);
- your versions: the output of `make doctor` (Node, pnpm, git and the agent CLIs), and your OS.

**Remove secrets before you paste anything.** Navarch redacts secrets it knows about, but check tokens, API keys, private repository names and paths yourself.

## Reporting a security problem

Do not open a public issue for a vulnerability, a prompt-injection path or a way around the Policy Engine. Open an issue asking for a private contact, without details, and the maintainer will reach out.

## Ideas and feature requests

Describe the problem you want solved, not only the solution. The product follows the spec ([`docs/navarch-especificacao.md`](docs/navarch-especificacao.md), in Portuguese) and its phased roadmap (§16), so an idea may be accepted but scheduled for a later phase. Decisions are recorded as ADRs in [`docs/adr/`](docs/adr).

## For the maintainer and the project's agents

How the repository is worked on, by the maintainer and by coding agents, is written down in [`AGENTS.md`](AGENTS.md). In short:

- **One branch and worktree per slice**, under `.worktree/<name>`; slice specs in [`docs/specs/`](docs/specs).
- **Every command goes through the root `Makefile`** (`make help`): `make install`, then `make verify` (typecheck + tests) before each commit, and `make ci` for everything CI runs. Tests use fake agent CLIs and a fake model server, so they never reach a real agent, the network or your keychain.
- **Contracts first:** Zod schemas in `packages/contracts`, then the implementation, with tests written alongside the code.
- **Conventional commits** (`feat:`, `fix:`, `docs:` …), in English. All documentation, comments and UI strings (through i18n) are in English.
- **Pull requests are opened as drafts**, and merging is always a human decision. Nothing is auto-merged.
- Architecture rules, security rules and the merge policy in `AGENTS.md` are non-negotiable; a change to them needs an ADR.
