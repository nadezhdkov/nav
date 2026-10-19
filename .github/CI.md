# CI

Every job calls a `Makefile` target, so `make ci` locally runs the same gates (it needs `gitleaks` and `actionlint` on the PATH).

| Workflow | Job | Runs | When |
|---|---|---|---|
| `ci.yml` | `verify` | `make typecheck`, `make test`, `make web-build`, `make site-build` on Node 22.18.0 (the `engines` floor) and Node 24 | every push and pull request |
| `pages.yml` | `build`, `deploy` | `make site-build` with `SITE_BASE=/nav/`, then GitHub Pages | push to `main` touching `site/`, or by hand |
| `ci.yml` | `lint-workflows` | `make lint-workflows` (actionlint) | every push and pull request |
| `security.yml` | `audit` | `make audit` (`pnpm audit --audit-level high`) | push, pull request, weekly on Monday |
| `security.yml` | `secrets` | `make secrets` (gitleaks over the full history) | push, pull request, weekly on Monday |
| `codeql.yml` | `analyze` | CodeQL for JavaScript/TypeScript with the `security-extended` queries, ignoring `test/` and `fixtures/` directories (`.github/codeql/codeql-config.yml`); results in Security → Code scanning | push to `main`, pull request, weekly on Monday |
| `dependency-review.yml` | `review` | fails a pull request that adds a dependency with a known vulnerability of high severity or worse | pull request |
| `dependabot.yml` | | grouped weekly updates for npm and GitHub Actions | weekly |

Rules:

- Workflows get `contents: read` only, and checkout does not keep the token (`persist-credentials: false`).
- Third-party actions are pinned by commit SHA with the version in a comment; Dependabot updates both. Downloaded tools (actionlint, gitleaks) are pinned by version and SHA-256.
- Tests never call a real agent CLI or model (fake CLIs and a fake model server), so CI needs no secrets.
- The repository is public, so CodeQL and dependency review are free for it. Only the CodeQL job gets `security-events: write`. Pull requests from forks run with the same read-only permissions and no secrets.
- Merging stays manual (AGENTS.md › Merge policy): CI reports, it never merges. The one deployment is the public site (`pages.yml`, ADR 0038), which publishes `site/` after a human has merged to `main`. Its `deploy` job alone gets `pages: write` and `id-token: write`.
