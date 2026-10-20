# Phase 5, slice 4: repositories from the phone

Status: implemented · Branch: `feat/phone-repos` · Spec: §6.7.1, §6.12.4 · ADR: 0072 · Builds on: ADR 0020, 0026

On a paired phone, New run showed only registered projects and repositories of earlier runs, so the phone could not start work on anything the PC had not already registered or create something new. The user asked for the phone to pick any repository and to create one (2026-10-19).

## Behavior

- `GET /api/v1/github/repos` and `POST /api/v1/github/repos/clone` are in `DEVICE_ROUTES`. A phone lists what the token reaches and clones one into `<home>/repos/<owner>/<name>`, registered as a project, as the desktop does. Only listed repositories can be cloned.
- `POST /api/v1/github/repos/create` (also a device route) takes `{ name, description?, private? }` and creates the repository on the token's own account (`POST /user/repos`, `auto_init`, private by default), then clones and registers it, answering the project (201).
  - Names are `[A-Za-z0-9._-]{1,100}`, not only dots and not ending in `.git`; the owner is always the token's account, never given by the client.
  - Policy action `repo.create` is allowed for the user (any channel, including a phone) and denied to every other actor. The event is `github.repo.created { repo, private }` with the actor, `via: "mobile"` and `device_id` for a phone.
  - GitHub's refusal (a name that exists, a token without Administration write) answers 502 with GitHub's message. The repository exists on GitHub once GitHub answered, even if the clone then fails; picking it clones it.
- New run (desktop and phone): "New repository" opens a name field and a private switch; on success the project is picked. The phone's note no longer says it is limited to registered projects.
- Unchanged for phones: no arbitrary paths as projects (`POST /projects` stays desktop only), no Flow, budget, adapter or attachments on a run, and no secrets.

## Acceptance

- A phone lists and clones a repository; the project's actor is the device; it can then start a run in it.
- A phone creates a repository: private by default, cloned and registered, `github.repo.created` recorded with the device.
- Bad names are refused (400) and an existing name answers 502 with GitHub's message.
- `POST /api/v1/projects` is still refused (403) to a phone.

## Not in this slice

- Creating under an organization, templates, a `.gitignore` or license choice.
- A CLI command to create a repository (`gh repo create` does it).
- 🔴 A lost phone can now create repositories on the account until it is revoked (Settings → Devices); the token's own permissions are the limit.
