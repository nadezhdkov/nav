# Phase 1, slice 12: GitHub repositories in New run

Status: implemented · Branch: `feat/github-repos` · Spec: §6.7.1, §6.7.4, §6.12.4 · ADR: 0026 · Builds on: ADR 0007, 0020, 0021

Until now, New run offered only registered projects and repositories of earlier runs, since every run needs a local clone. The user wants to pick any repository they work on, including private ones and those of their organizations, without cloning and registering it by hand first (asked on 2026-10-15).

## Behavior

- **Listing.** The GitHub Integration lists every repository the token reaches: `GET /user/repos?affiliation=owner,collaborator,organization_member&sort=pushed`, 100 per page, up to 10 pages. Each entry has `repo`, `owner`, `private`, `description`, `default_branch`, `pushed_at` and `can_push` (from `permissions.push`). The daemon adds `project_id` and `path` when the repository is a registered project. The listing is kept in memory for 60 s, and `?refresh=1` asks GitHub again.
  - What a fine-grained token reaches is what the user granted it: "All repositories" covers every repository of one owner (the user's account or one organization). An organization needs its own token today, or the GitHub App later (ADR 0007).
- **Cloning.** Picking a repository with no project clones it into `<home>/repos/<owner>/<name>` and registers it as a project (`project.added`), then the run starts there.
  - Only repositories the listing contains can be cloned (404 otherwise), so a request cannot make the daemon fetch arbitrary repositories.
  - The Policy Engine allows `repo.clone` only for the user. It then allows `project.add`, as for `navarch project add`.
  - The clone uses the token for that one `git clone` (`GIT_CONFIG_*` with `http.<github>/.extraheader`, as for pushes), with no template hooks, and its `origin` is left as the plain `https://github.com/<owner>/<name>.git`. No credential is written to disk.
  - A repository that is already a project returns that project (200) instead of cloning again. A clone left in place by an earlier attempt is reused when its origin matches.
- **Surfaces.**
  - API: `GET /api/v1/github/repos[?refresh=1]` → `GitHubRepoView[]`, `POST /api/v1/github/repos/clone {repo}` → `ProjectView` (201 cloned, 200 existing). GitHub or token errors answer 502 with GitHub's message. Neither route is open to paired devices.
  - CLI: `navarch repos [--refresh]`, `navarch project clone <owner/name>`.
  - Web, New run (desktop): a search field once there are more than 8 repositories, and a picker grouped as "On this computer" and "GitHub · <owner>" with "(private)" marked. Picking a GitHub repository shows that Navarch will clone it. When the token cannot push, a warning says the run can work but cannot open a PR. While the clone runs, the start button says "Cloning <repo>…". Without a token, the GitHub groups are left out with a short note. Phones keep the earlier list (ADR 0020).

## Out of scope

- 🔴 Refreshing managed clones: a clone in `<home>/repos` is not fetched before later runs, so a run starts from the commit it was cloned at, as with any clone the user keeps. Fetching before each run comes next.
- 🔴 Tokens per owner (`github/token/<owner>`) and the GitHub App, for organizations a single fine-grained token cannot cover.
- Issue runs from the picker: issues still come from the Inbox of registered projects or `--issue`.
