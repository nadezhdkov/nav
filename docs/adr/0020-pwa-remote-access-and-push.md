# 0020 — Mobile PWA: Tailscale Serve, paired device sessions, Web Push, pause and kill switch

- Status: accepted
- Date: 2026-10-15
- Spec: §6.10.3, §6.11, §6.12, §14.1, §15.1, §16 (Phase 1 "PWA mobile com Tailscale"), §19.5
- Slice: [`docs/specs/phase-1-07-pwa-mobile.md`](../specs/phase-1-07-pwa-mobile.md)
- Builds on: ADR 0017 (Web UI and sign-in code), ADR 0019 (instruction interrupts)

## Context

Phase 1 asks for a mobile PWA over Tailscale. The phone needs to list runs, decide approvals, receive push notifications, pause and cancel runs, and send instructions. The go/no-go needs "approval from the phone, from outside the local network". Several questions needed an answer:

1. **How the phone reaches the daemon.** `navarchd` binds `127.0.0.1`, and the spec forbids exposed ports. Binding to the tailnet address would give plain HTTP, but service workers and Web Push need a secure context, and browsers treat `http://100.x.y.z` as insecure.
2. **How a phone signs in.** The Web UI uses the long-lived local token, delivered once through a single-use code (ADR 0017). Handing that token to a phone would give it every power the CLI has, with no way to revoke one phone.
3. **How to send Web Push.** The `web-push` package and its dependencies, or our own sender.
4. **What a notification may do.** §6.11 mentions "Approve plan" from the notification, while AGENTS.md says an approval must show what, why, the plan or diff, and the cost.
5. **Pause.** The `paused` state exists, but only a quota wait enters it (ADR 0005). Users can neither pause a run nor stop everything at once (§6.12.4 "kill switch").

## Decision

### Remote access through `tailscale serve`

- The daemon keeps listening on loopback. The user runs `tailscale serve --bg <port>`, which serves `https://<machine>.<tailnet>.ts.net` inside the tailnet only, with a certificate Tailscale manages, and proxies to the daemon. That answers §19.5 for the MVP: Tailscale is the topology, and the relay waits for Phase 4.
- Navarch never changes the Tailscale configuration. `navarch remote status` checks it and prints the command.
- Proxied requests come from loopback, so **the source address proves nothing**. Every API request is authenticated by token, and the WebSocket origin check also accepts the configured remote origin (`daemon.remote.url`, otherwise detected with `tailscale status --json`).

### Paired devices with short-lived access and rotating refresh tokens

- The desktop UI (local token) creates a pairing code: 256 bits, single use, 5 minutes, held in memory. The UI shows it as a QR code of `https://<remote>/#pair=<code>`. The fragment never reaches a server log or a proxy.
- Pairing creates a **device**, recorded by a `device.paired` event, and returns two tokens:
  - an **access token** valid for 15 minutes: an HMAC-SHA256 over the device id and the expiry, with a key in `~/.navarch/device-key` (0600). Each check looks up the device's revocation in the projection, so revoking takes effect at once;
  - a **refresh token** valid for 30 days since last use and rotated on each use. Only its SHA-256 hash is stored. Reusing a rotated refresh token revokes the device (theft detection).
- The refresh-token hashes and the push subscriptions live in daemon-owned tables that are **not projections**, so no event ever carries them and a rebuild leaves them alone. Device existence and revocation are events, so they are part of the audited log.
- A device has a **route allowlist**: reading runs, approvals and the fleet, deciding approvals, pause, resume and cancel, instructions, new prompt runs in known repositories, the kill switch, its own push subscription, and revoking itself. Secrets, pairing, sign-in codes, other devices and the concierge stay on the PC. An allowlist fails closed when a new route is added.
- The actor of a device's action is `{ kind: "user", via: "mobile", device_id }`.
- **WebAuthn is deferred** until the first action that §6.10.3 says needs re-authentication exists. Those actions are manual merge, enabling auto-merge, policy changes and budget increases, and none is in the product yet. That action's slice adds WebAuthn and makes the policy require it for device actors.

### Web Push, sent by our own code

- VAPID (RFC 8292, ES256 JWT) and `aes128gcm` content encryption (RFC 8291) take about 150 lines of `node:crypto` and are fully specified, with published test vectors. Writing them ourselves keeps the daemon free of the `web-push` dependency tree, which follows the `node:sqlite` precedent (ADR 0002).
- The VAPID key pair is created on first use in `~/.navarch/push/vapid.json` (0600). It is a daemon credential like `~/.navarch/token`, not a third-party secret, so it lives next to the token and not in the OS keychain.
- The daemon POSTs only to `https` endpoints whose host is in `notifications.push_hosts`. The defaults are FCM, Mozilla autopush, Apple and WNS. A paired device therefore cannot make the daemon call arbitrary URLs (SSRF).
- A **Notifier** in the daemon subscribes to the event store and maps a few events to notifications, with tags per run and kind, 10-second coalescing, and quiet hours that let only critical notifications through. Each send asks the Policy Engine (`notification.send`) and records `notification.sent` or `notification.failed`. Payloads hold a title, a short body and a URL, never code, diffs or logs.

### Notifications open the app, they do not act

- A notification's actions only deep-link: *Open*, plus *View plan* or *View diff* for an approval. The approval itself happens on the screen that shows what, why, the plan or diff, and the cost.
- The user would accept approve or reject inside the notification only for low-risk changes, such as docs-only or very small diffs. That needs a risk classification of changes that does not exist yet, so it is recorded as open work, not built.

### User pause and the kill switch

- `POST /runs/:id/pause` moves the run to `paused` with reason `user`. It interrupts running tasks without using an attempt, reusing the instruction interrupt path of ADR 0019 with reason `pause`. The Scheduler skips ready tasks of paused runs.
- `resume` returns the run to the status it had before the pause instead of always `executing`. This also fixes resuming a quota-paused run that was, say, `verifying`.
- `POST /stop` (the kill switch) pauses every active run and records `fleet.stopped`. Pausing loses nothing, unlike cancelling: each run can then be resumed or cancelled.
- `run.pause`, `run.resume` and `fleet.stop` are Policy Engine actions allowed for users only. No state is added (§8.3/§8.4).

## Consequences

- The go/no-go approval from outside the network needs Tailscale on the PC and on the phone, plus `tailscale serve`. Users without Tailscale have no remote access until the relay exists.
- The SPA has two sign-in modes: the local token (desktop, `sessionStorage`) and a device session (phone, refresh token in `localStorage`). The API client refreshes the access token on 401 and before expiry.
- Web Push on iOS works only for a PWA installed on the home screen. The Device screen says so.
- Notifications travel through the browser vendors' push services, encrypted end to end. Only timing, size and the endpoint are visible to them.
- Two new daemon-owned files: `~/.navarch/device-key` and `~/.navarch/push/vapid.json`. Deleting `device-key` signs every device out at its next request, and its refresh still works because the refresh tokens are separate. Deleting `vapid.json` invalidates every push subscription.
