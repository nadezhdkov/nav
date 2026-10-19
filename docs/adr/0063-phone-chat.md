# 0063 — Chat with the concierge from a paired phone

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0016 (concierge), ADR 0020 (device sessions), ADR 0028 (attachments)

## Context

The concierge was desktop and CLI only; ADR 0020 kept it out of `DEVICE_ROUTES` because its tools ran as a generic user and could do more than a phone may do by hand. The user wants to chat from the phone, with text, dictation and Markdown files, and to confirm the proposed actions on the phone too.

## Decision

1. **Three routes for devices**: opening a conversation, sending a message and deciding a proposal. Each conversation remembers the device that opened it; a device reaches only its own (`not_found` otherwise), and the desktop and the CLI reach any. A device sets no working directory.
2. **The phone acts as itself.** The concierge's actor carries `via: "mobile"` and the `device_id`, so events and the Policy Engine see the phone and not a generic user. Confirming a proposal on the phone is the user's yes, as the user chose.
3. **Same limits as the REST routes.** The concierge's tools bypass the route handlers, so `start_run` for a device holds to the rule of `POST /runs`: a prompt in a registered project or a repository of an earlier run, and nothing else (no Flow, budget, adapter, issue, pull request or attachments). Other act tools were already allowed to devices (cancel, resume, instruct, approve, reject); the policy rules that bar phones (`away.set`, `flow.*`, `principles.set`) stay in force.
4. **Files go inside the message.** The PWA reads text files in the browser (UTF-8, no NUL), puts each in an `<attached_file name="…">` block after the typed text, and a closing tag inside a file cannot end its block. The whole message stays within the daemon's 8,000 characters. The `attach` argument of `start_run` is never used from a phone, since it reads server paths.
5. **Dictation is the browser's own** (`SpeechRecognition`, in the interface language). Navarch uploads no audio and keeps no transcription key; where the browser has none, the button says so.
6. **Everything the model or a file says is shown as plain text.**
7. **CLI mascot.** `navarch` and `navarch chat` show a ship with its helmsman beside the name, in colour only on a terminal that wants it (`NO_COLOR`, `TERM=dumb`); with no terminal the old one-line header is kept.

## Consequences

- 🟡 A phone that is lost or taken can confirm proposals until the user revokes it; the confirmation is not behind a security key (ADR 0062 covers auto-merge only).
- 🟡 Conversations live in daemon memory, so a restart ends them; the PWA opens a new one on a 404.
- 🟡 Dictation depends on the browser's speech service, which may send audio to its vendor.
- 🔴 Audio files are not transcribed by a model (cost and a key); not built.
