# 0073 — A workspace folder, `@` mentions inside projects, and `create_repo`

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0072 (phone repositories), ADR 0063 (phone chat)

## Context

The user keeps all projects in one folder and uses `@path` in Claude Code. They asked for the same in the phone chat, and for the chat to create repositories there, but not for browsing the rest of the PC, and the folder must be configurable because others use different layouts.

## Decision

1. `workspace.root` is daemon configuration, never read from a repository. It only decides where clones and new repositories go.
2. Mentions are limited to registered projects and to what git lists in them. That excludes ignored files (where `.env` and keys usually are) and `.git`; a read also checks the real path against the clone to refuse tracked symlinks that lead out.
3. A mention is attached by the client as a delimited, untrusted `<attached_file>` block, the mechanism of ADR 0063, so the concierge has no filesystem tool and gains no way to read the PC.
4. `create_repo` is a concierge act tool over the existing `createProject`, with the confirmation every act tool needs.

## Consequences

- 🟢 `@docs/` and creating repositories work from the phone, in the folder the user already uses.
- 🟡 A tracked file that holds a secret (committed by mistake) can be mentioned from a paired phone. That is what the phone could already see in a run's diff, and a lost phone is revoked in Settings → Devices.
- 🟡 Folders of the workspace that are not registered projects cannot be mentioned until registered.
