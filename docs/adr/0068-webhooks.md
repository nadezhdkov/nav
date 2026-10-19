# 0068 — GitHub webhooks through the relay, as nudges

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0021 (Inbox polling), ADR 0037 (PR watcher), ADR 0041 (CI watcher), ADR 0066 (relay)

## Context

The Inbox, the PR watcher and the CI watcher poll every `inbox.poll_minutes`. The spec (GitHub Integration) names webhooks for when a public URL exists, and the relay is that URL. The relay holds no key, and a webhook is signed with a secret.

## Decision

1. **The relay forwards, the daemon verifies.** `POST /w/<id>` on the relay hands the raw body and four headers to the daemon over its existing socket and relays the daemon's status code. The HMAC is checked in the daemon against a Vault secret, so the relay never holds it and cannot forge a delivery. The relay stores nothing.
2. **A webhook is a nudge, not a command.** The daemon uses only the repository name, event and action, matches the repository to a registered project, and runs the reads it runs on a poll. A forged delivery that somehow passed the signature could only make the daemon read GitHub sooner. Polling stays, so a missed delivery costs latency, not correctness.
3. **Nothing unauthenticated writes to the log.** Rejected deliveries (503, 401, 413) are counted in memory only; accepted ones record `webhook.received`.
4. **The user creates the webhook** in the repository's settings with the payload URL and secret `navarch webhook` explains. Navarch does not write to GitHub for this.

## Consequences

- 🟡 The relay sees webhook payloads (GitHub data about the repository), unlike the phone traffic. Host your own relay.
- 🟡 A delivery while the daemon is off fails; GitHub shows it and the next poll catches up.
- 🟡 Not tested against the real GitHub; the signature scheme is GitHub's documented one and tested with the same HMAC.
