# 0074 — Live Claude Code sessions

- Status: accepted
- Date: 2026-10-20
- Builds on: ADR 0020 (phone), ADR 0023 (budgets), ADR 0063 (phone chat), ADR 0073 (mentions)

## Context

Runs are unattended and the concierge cannot edit code, so a phone had no way to talk to Claude Code itself: no images, no `@` files, no follow-up in the same conversation. Anthropic's own remote control does that but sits outside Navarch. The user wanted it inside the app. `claude` 2.1.304 has what is needed: streamed JSON input and output, partial messages, and `--permission-prompt-tool stdio`, which sends each permission question to the host and waits.

## Decision

1. A session is a long-lived `claude` process in a registered project's own folder, driven over stream-json, with a transcript the UI polls. It is not a run: no Flow, no worktree, no approvals engine.
2. Every question Claude Code asks (`can_use_tool`) is answered only by the user in the app, never by a rule or a model. The default mode asks for edits and commands; `acceptEdits` is an explicit choice.
3. Whether sessions exist is `sessions.enabled` in the daemon's own config, which only the PC edits. Opening one is Policy `session.open`, the user's.
4. It uses the operator's own Claude Code settings (`setting_sources` includes `user`), because it is their session.
5. Plan logins only: a session whose Claude Code is on an API key is closed at once, and `--max-budget-usd` caps the rest, so nothing is billed outside the budgets.

## Consequences

- 🟢 The phone can send text, images and `@` files to Claude Code and follow the work, as at the terminal.
- 🟡 A lost, unrevoked phone can drive a session in a project folder, limited by what each question allows. Revoke it in Settings → Devices; keep `permission_mode: default`.
- 🟡 Session use counts against the plan's quota but not against Navarch's budgets (plan use is not billed, ADR 0023).
- 🟡 A question that needs a phone's answer waits silently until a push is added.
