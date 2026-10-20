# Phase 5, slice 6: live Claude Code sessions

Status: implemented · Branch: `feat/sessions` · ADR: 0074 · Builds on: ADR 0020, 0063, 0073

The concierge reads Navarch's state and proposes actions, but it cannot edit code, take images or follow a conversation the way Claude Code does. The user wanted to talk to Claude Code itself from the phone, inside Navarch, with the same freedom as at the terminal (asked 2026-10-20).

## Behavior

- **Off by default.** `sessions.enabled` (daemon config, PC only) gates everything; `GET /api/v1/sessions` answers `enabled`, and a request to open one answers 403 `disabled` otherwise. A phone cannot turn it on.
- **Opening.** `POST /api/v1/sessions { project_id, permission_mode?, resume? }` starts `claude` in the registered project's folder (Policy `session.open`, the user's, from any channel). At most `sessions.max_open` at once (409). `resume` continues a closed session's Claude Code conversation (`--resume`), in the same project.
- **Talking.** `POST /api/v1/sessions/:id/messages { text, images? }` writes a stream-json user message (text up to 20,000 characters; up to 3 images, PNG, JPEG, WebP or GIF, 2.8 M base64 characters each). The answer arrives as items: `assistant` text, `tool` lines, `permission` questions and `notice`s; `GET /api/v1/sessions/:id?after=<seq>` returns the items after a `seq` and `live`, the text being written. The UI polls (every 0.7 to 1.5 s), so it works over the relay too.
- **Permissions.** With `--permission-prompt-tool stdio` Claude Code sends a `can_use_tool` request for everything its mode does not allow. It becomes a `permission` item with status `pending`; the user answers `allow` or `deny` (`POST /api/v1/sessions/:id/permissions/:request`, single use), and a refusal's message reaches the model. Questions open when a session closes are `expired`.
- **Limits.** The session is closed when it is idle for `sessions.idle_minutes`, when Claude Code reaches `--max-budget-usd sessions.max_cost_usd`, when the process exits, on `DELETE`, or at once when `init` reports an API-key login (`apiKeySource` not `none`): that use would be billed outside the budgets (ADR 0023).
- **Record.** `session.opened`, `session.message` (text redacted, images counted), `session.reply` (each turn's answer and the session's cost so far, API-equivalent), `session.permission` (with the decision and the actor, a device included) and `session.closed`.
- **Web UI.** `/session`, from a button in Chat: pick a project and what it may do without asking, then a transcript with approve/refuse buttons on each question, an image button (photos are scaled to 1600 px and re-encoded in the browser) and `@` suggestions for files of the project (Claude Code reads `@path` itself). Strings in the five locales.

## Acceptance

- Off by default and not enabled by a phone; opens in the project's folder with the stdin protocol flags; the answer streams as `live`; a permission waits until answered, and a refusal reaches the agent; images reach the agent; an API-key login closes the session; unknown project 404, over the cap 409, bad message 400; a closed conversation can be continued.
- Against the real `claude`: a Write was asked, allowed (file made) and a second refused (no file).

## Not in this slice

- A push notification for a waiting question.
- Running the session in an isolated worktree (it works in the project's own folder, which is the point).
- Sessions outside registered projects, and a CLI for sessions.
- Persisting the transcript across a daemon restart (the conversation can be continued with `resume`, not re-read).
