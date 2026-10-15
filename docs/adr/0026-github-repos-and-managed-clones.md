# 0026 — Listing GitHub repositories and cloning them for runs

- Status: accepted
- Date: 2026-10-15
- Spec: §6.7.1 (authentication), §6.7.4 (features), §6.12.4 (new work)
- Builds on: ADR 0007 (fine-grained PAT, GitHub Integration as the only client), ADR 0020 (device limits), ADR 0021 (projects)

## Context

A run needs a local clone. New run offered only the clones Navarch already knew: registered projects and repositories of earlier runs. The user asked to see every repository they work on there, private ones and those of the organizations they belong to included, and to start a run on any of them.

## Decision

- **The GitHub Integration lists repositories** with `GET /user/repos` (owner, collaborator and organization member), keeps the list for 60 s and marks registered projects. The list is exactly what the token reaches, so the token is still the boundary of what Navarch can touch. With a fine-grained token that means the repositories of one owner (or all of them, with "All repositories").
- **Navarch clones a picked repository into `<home>/repos/<owner>/<name>`** and registers it as a project. The location sits beside `worktrees/`, so Navarch never writes into the user's own folders; run worktrees still come from it as from any clone (spec §6.5.2).
- **Only listed repositories can be cloned.** Cloning is the Policy Engine action `repo.clone`, allowed for the user only, never for agents. The routes are not open to paired devices.
- **The token reaches git for one command**, as for pushes (ADR 0007): `GIT_CONFIG_*` sets an `extraheader` scoped to the GitHub URL and empties the credential helper. The clone runs with `--template=` so no operator hook templates run, and its `origin` is the plain GitHub URL. No credential is written to the clone.

## Consequences

- One click from any repository the token reaches to a run, with no manual clone or `project add`.
- Managed clones are not refreshed yet. A run starts from the commit the repository was cloned at until a fetch before each run is added.
- Organizations need a token each or, better, the GitHub App, which ADR 0007 already expected "when Navarch works on repositories the user does not own". The listing and the clone take the token from the Vault on each use, so either change stays inside the GitHub Integration.
