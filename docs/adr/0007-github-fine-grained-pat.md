# 0007 — GitHub access through a fine-grained PAT kept in the OS keychain

- Status: accepted
- Date: 2026-10-14
- Spec: §6.1.5 (Secrets Vault), §6.7.1–6.7.2 (GitHub authentication and permissions), §10.2, §16 Phase 1
- Supersedes: nothing; a GitHub App is expected to supersede the token part later

## Context

Phase 1 reads issues and opens draft PRs. Spec §6.7.1 recommends a GitHub App and allows a fine-grained personal access token "for a simple start". The Phase 1 go/no-go requires that no run ever writes outside `vectr/*`, checked by audit, so the credential's reach matters as much as the code's.

The options were:

- **The `gh` CLI token:** no setup, but it is a broad OAuth token (all repositories, `repo` scope). A bug or a prompt injection that reached it could write anywhere the user can.
- **A GitHub App:** short-lived installation tokens, granular permissions and webhooks. It is the better long-term answer but needs app registration, a private key and token minting before the first PR.
- **A fine-grained PAT:** limited to the repositories the user picks and to the permissions in §6.7.2, revocable, no extra infrastructure.

## Decision

- **Phase 1 uses a fine-grained PAT**, created by the user for the repositories VECTR works on, with: Metadata (read), Contents (read and write), Issues (read), Pull requests (read and write). Contents write is the only way to push `vectr/*` branches; the Policy Engine and the GitHub Integration are what keep writes on `vectr/*` (`git.push` rule, no force, branch name checked before every push).
- **The token lives in the Vault as `secret://github/token`**, never in config files, events or logs:
  - Backend: the OS keychain through libsecret's `secret-tool` (Linux), attribute `service=vectr`, `name=github/token`. `vectr secret set github/token` reads the value from stdin.
  - For tests and headless setups, `VECTR_SECRET_GITHUB_TOKEN` in the daemon's environment takes precedence. It is documented as the less safe option.
  - The value is registered for redaction as soon as it is read, and only the GitHub Integration receives it. Agents never do: their environment is scrubbed and their grant denies `~/.config/gh`.
- **Pushes** pass the token for a single `git push` through `GIT_CONFIG_*` environment variables (`http.extraheader`), so it is never written to the repository's git config, the URL or the command line.
- **A GitHub App replaces the PAT later** (user decision, 2026-10-14), when VECTR needs webhooks or works on repositories the user does not own. The GitHub Integration takes a token provider, so that change does not touch its callers.

## Consequences

- One manual step: the user creates the PAT and stores it with `vectr secret set github/token`.
- PATs expire (the user picks the date); an expired token fails the GitHub step with a clear message, not the whole run.
- macOS and Windows keychains are not implemented yet; `VECTR_SECRET_*` works there meanwhile.
