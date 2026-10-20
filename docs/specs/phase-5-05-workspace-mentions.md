# Phase 5, slice 5: workspace folder, `@` mentions and `create_repo`

Status: implemented · Branch: `feat/workspace-root` · ADR: 0073 · Builds on: ADR 0026, 0063, 0072

The user keeps every project in one folder and wants the phone chat to create repositories, and to mention files and folders of a project with `@`, as in Claude Code. Other people keep theirs elsewhere, so the folder is configuration.

## Behavior

- **`workspace.root`** in `~/.navarch/config.yaml`: an absolute path or one starting with `~/`. Cloning or creating a repository (`/github/repos/clone|create`, New run, the chat) puts it in `<root>/<name>`; without it, in `<home>/repos/<owner>/<name>` as before. A folder already there with another origin is refused by `addProject`'s origin check.
- **Files for `@`.** `GET /api/v1/projects/:id/files?q=&prefix=&kind=&limit=` lists folders, then files, of the project's clone (`git ls-files`, so ignored files and `.git` never appear), filtered by words in `q` and by `prefix`, shortest first, at most 500. `GET /api/v1/projects/:id/file?path=` returns a text file's content only when git lists the path and its real path stays inside the clone (a tracked symlink to `~/.ssh` is refused), as text up to 512 KiB. Both are readable by paired devices.
- **Chat.** Typing `@` shows the registered projects; `@name/` shows folders and files inside; a folder narrows further, and "attach this folder" adds its file list. A picked file is added like an attachment (`<attached_file>`, same size limit), so the model treats it as the user's data.
- **`create_repo`** (act tool, also on a phone): `name`, optional `description`, `public` (default private). The proposal says what will be created; after the yes it calls `InboxService.createProject`, as in ADR 0072.

## Acceptance

- With `workspace.root`, create and clone land in `<root>/<name>`; without it, in the Navarch home.
- Files list folders then files, never `.env`/`.git`; read answers 404 for ignored, binary, unlisted, absolute, `..` and symlinked-outside paths.
- `create_repo` is an act tool, private by default, rejects bad names.

## Not in this slice

- Browsing folders outside registered projects, or an allowlist of extra folders.
- Registering existing unregistered folders of the workspace as projects.
- Creating a local-only project with no GitHub repository.
