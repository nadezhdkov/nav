# CI

Every job calls a `Makefile` target, so `make ci` locally runs the same gates (it needs `gitleaks` and `actionlint` on the PATH).

| Workflow | Job | Runs | When |
|---|---|---|---|
| `ci.yml` | `verify` | `make typecheck`, `make test` on Node 22.18.0 (the `engines` floor) and Node 24 | every push and pull request |
| `ci.yml` | `lint-workflows` | `make lint-workflows` (actionlint) | every push and pull request |
| `security.yml` | `audit` | `make audit` (`pnpm audit --audit-level high`) | push, pull request, weekly on Monday |
| `security.yml` | `secrets` | `make secrets` (gitleaks over the full history) | push, pull request, weekly on Monday |
| `dependabot.yml` | | grouped weekly updates for npm and GitHub Actions | weekly |

Rules:

- Workflows get `contents: read` only, and checkout does not keep the token (`persist-credentials: false`).
- Third-party actions are pinned by commit SHA with the version in a comment; Dependabot updates both. Downloaded tools (actionlint, gitleaks) are pinned by version and SHA-256.
- Tests never call a real agent CLI or model (fake CLIs and a fake model server), so CI needs no secrets.
- The repository is private: CodeQL and dependency review need GitHub Advanced Security and are not used. Turn them on if the repository becomes public.
- Merging stays manual (AGENTS.md › Merge policy): CI reports, it never merges or deploys.
