# Phase 4, slice 9 — GitHub webhooks through the relay

Status: implemented. ADR 0068. Spec §6.12.2 (relay), "Webhooks quando houver URL pública (via relay)" in the GitHub Integration section.

## Behaviour

- The relay serves `POST /w/<relay id>`. It passes the raw body and four headers (`x-github-event`, `x-github-delivery`, `x-hub-signature-256`, `content-type`) to the daemon on its outgoing socket and answers GitHub with the daemon's status. It stores nothing: an offline daemon is a 503, a daemon that does not answer in 8 s a 504, a body over 1 MiB a 413, and each address gets 120 requests a minute.
- The daemon checks `X-Hub-Signature-256` (HMAC-SHA256 of the body, constant-time) against `secret://github/webhook_secret`. No secret is 503, a wrong or missing signature 401, and neither is recorded as an event (anyone can reach a public relay, so the log must not grow from them).
- A signed `ping` answers 200. `issues`, `pull_request`, `check_run` and `check_suite` for a **registered project's** repository answer 202 and record `webhook.received`; anything else is 202 `ignored`. A delivery id is used once for an hour.
- A webhook only **nudges**. After a 2 s debounce per project the daemon runs the reads it already runs on its poll: `issues` → Inbox sync of that project; `pull_request` closed → PR watcher; `pull_request` opened, reopened, synchronize or closed, and a finished `check_run` or `check_suite` → CI watcher. Nothing from the payload is stored or acted on beyond the repository name, the event and the action.
- `navarch webhook` (`GET /api/v1/webhooks`, desktop only) shows the payload URL, whether the relay is connected and the secret stored, and the counters.

## Acceptance

- A correctly signed delivery for a registered project makes the matching read run once per burst; a bad signature, an unknown repository, an unlisted event and a replayed delivery id make none.
- Without a relay there is no payload URL; polling is unchanged and still the fallback.

## Not in this slice

- Creating the webhook on GitHub (a write the user does in the repository's settings), the `form` content type, label triggers, and webhooks without a relay.
