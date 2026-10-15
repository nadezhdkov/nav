# Phase 1, slice 7: mobile PWA over Tailscale, push, pause and kill switch

Status: implemented · Branch: `feat/pwa` · Spec: §6.10.3, §6.11, §6.12, §14.1, §15.1 (Mobile), §16 (Phase 1 "PWA mobile com Tailscale") · ADR: 0020

The phone is a remote control and a dashboard for the work on the PC (§6.12.1). This slice makes the Web UI an installable PWA that the phone reaches over the tailnet. It adds device pairing by QR code, Web Push for what needs the user, pausing and resuming a run, and a kill switch that stops everything. It covers every MVP row of §6.12.4 and the Phase 1 go/no-go item "approval from the phone, from outside the local network".

## Behavior

### Remote access (Tailscale)

- `navarchd` stays bound to `127.0.0.1`. The phone reaches it through **`tailscale serve`**, which publishes `https://<machine>.<tailnet>.ts.net` inside the tailnet only and proxies to the daemon. No port is exposed to the internet or the LAN. HTTPS is required anyway: service workers and Web Push only run in a secure context.
- `navarch remote status` reports whether `tailscale` is installed and logged in, the machine's tailnet URL, and whether `tailscale serve` already proxies to the daemon's port. It prints the one command to run when it does not (`tailscale serve --bg <port>`). Navarch never changes the Tailscale setup itself.
- Config (§14.1): `daemon.remote.mode` (`tailscale` | `off`, default `tailscale`) and `daemon.remote.url` (the HTTPS origin; detected from `tailscale status --json` when unset). With `off`, pairing is refused.
- Requests proxied by `tailscale serve` look local. The daemon therefore authenticates **every** API request by token, whatever its source address. The local token or a device session is accepted, and nothing is trusted by IP.
- The WebSocket origin check also accepts the configured remote origin.

### Pairing and device sessions (§6.12.3)

- In the desktop Web UI, **Settings → Devices** shows the paired devices (name, paired at, last seen, notifications on/off) with *Revoke*, plus a **Pair a phone** button.
- *Pair a phone* asks the daemon for a pairing code (`POST /api/v1/devices/pairings`, local token only). The code has 256 bits, is single use, is valid for 5 minutes and is kept in memory. The UI shows `https://<remote url>/#pair=<code>` as a QR code and as text, with a countdown.
- The phone opens the link. The SPA sends the code and a device name (prefilled from the user agent, editable) to `POST /api/v1/devices/pair`, which returns a **device session**:
  - an **access token** valid for 15 minutes, signed by the daemon with HMAC-SHA256 and carrying the device id and expiry;
  - a **refresh token**, 256 random bits, valid for 30 days since its last use and **rotated on every refresh**. Only its SHA-256 hash is stored.
- `POST /api/v1/devices/refresh` trades a refresh token for a new pair. Presenting a refresh token that was already rotated revokes the device, since someone else may hold a copy.
- A revoked device's access token stops working at once: every request checks the device in the projection.
- The phone keeps the refresh token in `localStorage`, so the installed app survives restarts, and the access token in memory. The strict CSP is the guard against injected scripts.
- **Device scope** is an allowlist. A device can read runs, the fleet, approvals, artifacts, events and logs, and the stream. It can decide approvals, cancel, pause and resume runs, send instructions, start a prompt run in a repository already used by a run, use the kill switch, manage its own push subscription, and revoke itself. It cannot read or set secrets, create pairing or sign-in codes, list or revoke other devices, or use the concierge. Those stay on the PC.
- The actor of anything done from a device is `{ kind: "user", via: "mobile", device_id }`.
- WebAuthn re-authentication (§6.10.3) is still not needed: none of the actions it guards (manual merge, enabling auto-merge, policy changes, budget increases) exists yet. The ADR records that the first such action brings WebAuthn with it.

### Pause, resume and kill switch

- **Pause a run** (`POST /api/v1/runs/:id/pause`, CLI `navarch pause <run>`, Web UI and phone) works on a run that is not terminal and not already paused:
  - the run goes to `paused` with reason `user`;
  - each running task is interrupted (`running → interrupted → ready`, reason `pause`), and the interruption does not count as an attempt, like an instruction interrupt (ADR 0019);
  - the Scheduler dispatches no task of a paused run;
  - a task waiting for an approval keeps waiting, and approving it does not start it while the run is paused.
- **Resume** (`POST /api/v1/runs/:id/resume`, which already exists) returns the run to the status it had before the pause. The `from` of the last `→ paused` transition records that status. Failed tasks are requeued as today (quota pause, ADR 0005), and ready tasks are dispatched again. Resumable adapters continue their session.
- **Kill switch** (`POST /api/v1/stop`, CLI `navarch stop --all`, a red "Stop everything" on the phone's Home and in the desktop sidebar) pauses every active run as above in one call and records one `fleet.stopped` event with the run ids. Pausing instead of cancelling means nothing is lost: each run can be resumed or cancelled afterwards. The UI states this before confirming: "Pauses N running runs and stops their agents. Nothing is cancelled; you can resume each run."
- Policy (rule 3): actions `run.pause`, `run.resume` and `fleet.stop` are allowed for the user only.

### Notifications (§6.11)

- **Web Push** to every device with notifications on. A *Notifications* switch in the phone's Device screen asks the browser for permission and subscribes. On iOS this works only once the PWA is installed on the home screen, and the screen says so.
- What is sent, with a minimal payload: title, a short body (the run title, truncated), the URL to open, and a `tag` per run and kind. No code, diff, log or secret is ever in a payload; payloads are encrypted end to end anyway (RFC 8291).

  | Event | Notification | Priority |
  |---|---|---|
  | `approval.requested` | "Approval needed: plan / PR / verification" → the approval | normal |
  | run → `failed`, `budget_exceeded` | "Run failed" / "Budget reached" → the run | critical |
  | run → `paused` by a quota (not by the user) | "Paused until …" → the run | normal |
  | run → `pr_opened`, `done` | "Draft PR opened" / "Run done" → the run | normal |
  | task waiting for a quota reset > 1 h | not sent (shown in the Fleet) | — |

- **Opening the app, never acting from the notification.** Its actions are *Open* (approval or run), plus *View plan* or *View diff* for an approval, and they deep-link to the screen that shows what will happen, why, the plan or diff, and the cost (AGENTS.md "Web layer").
- **Grouping**: notifications share a `tag` per run and kind, so a newer one replaces the older one on the phone. Events of the same run and kind within 10 seconds are coalesced into one ("3 approvals waiting in run …").
- **Quiet hours** (`notifications.quiet_hours: { start, end, allow_critical }`, local time of the PC): only critical notifications are sent during them. `notifications.web_push: false` turns Web Push off.
- Every send goes through the Policy Engine (action `notification.send`, rule 3) and is recorded as `notification.sent` (channel, device, kind, run). A failure is recorded as `notification.failed`. A subscription that the push service answers with 404 or 410 is dropped.
- **Push endpoint allowlist**: the daemon only POSTs to `https` endpoints whose host matches `notifications.push_hosts`. The default list holds the FCM, Mozilla, Apple and Windows push services. This keeps a device from turning the daemon into an HTTP client for arbitrary URLs.
- **Sender**: VAPID (RFC 8292, ES256) and `aes128gcm` payload encryption (RFC 8291), implemented with `node:crypto` and no dependency. The VAPID key pair is created on first use and kept in `~/.navarch/push/vapid.json` (mode 0600), like the daemon token.

### Mobile layout (§15.1 "Mobile (PWA)")

The same SPA and routes. At ≤ 768 px the sidebar becomes a bottom tab bar (Home, Approvals, Runs, Device) with touch targets ≥ 44 px, safe-area insets and no hover-only affordances.

- **Home** (`/home`, also the start page on phones): the kill switch, the pending approvals count (a link to Approvals), active runs as cards (title, status icon + text, current node, cost vs. budget, waiting reason), and a *New run* button. On desktop, Home is in the sidebar too; the full Inbox/Home of §15.3 is the next slice.
- **Approvals**: the existing screen, single column. Each item shows what, why, the plan or diff summary, and the cost, with Approve / Reject (rejection reason optional) and confirmation.
- **Run** (the existing route; on phones a single-column layout without the graph): header (title, status, cost vs. budget), Pause/Resume/Cancel with confirmation, a timeline of events, the model per task, and the instruction box (next turn only, as in ADR 0019).
- **New run** (`/new`): prompt text and a repository picked from those of earlier runs (`GET /api/v1/repos`). The Flow is `task` and the budget is the default. Start goes through `POST /api/v1/runs` as on the CLI.
- **Device** (`/device`): this device's name, paired date, the notifications switch, and *Sign out*, which revokes this device.
- **PWA shell**: `manifest.webmanifest` (name Navarch, `display: standalone`, dark theme and background colors, start URL `/home`, 192/512 px and maskable icons from `favicon.svg`, `apple-touch-icon`), plus a service worker `sw.js` that handles `push` and `notificationclick` (focus an open window or open the URL). The service worker does **not** cache the API, and it caches the app shell only so the app opens offline with an "offline" banner.
- All new strings in the five locales.

## API and contracts (contracts first, `packages/contracts`)

- `Actor` user gains `device_id?: string`.
- Devices:
  - `DeviceView { id, name, paired_at, last_seen_at, revoked_at, push: boolean }`;
  - `POST /api/v1/devices/pairings` → `DevicePairing { code, url, expires_at }` (local token only; 409 when `remote.mode` is `off` or no remote URL is known);
  - `POST /api/v1/devices/pair { code, name }` → `DeviceSession { device: DeviceView, access_token, access_expires_at, refresh_token }`. This route and `refresh` need no bearer: the code or the refresh token is the credential;
  - `POST /api/v1/devices/refresh { refresh_token }` → `DeviceSession`;
  - `GET /api/v1/devices` (local token) and `GET /api/v1/devices/me` (device);
  - `DELETE /api/v1/devices/:id` (the local token, or the device itself).
- Push:
  - `GET /api/v1/push/key` → `{ public_key }` (VAPID, base64url);
  - `PUT /api/v1/push/subscription { endpoint, keys: { p256dh, auth } }` and `DELETE /api/v1/push/subscription`, device only (one subscription per device).
- Runs: `POST /api/v1/runs/:id/pause` → `RunView`; `POST /api/v1/stop` → `{ paused: string[] }`; `GET /api/v1/repos` → `{ path, last_run_at }[]`.
- Events, with no secrets, tokens, hashes or push keys: `device.paired { device_id, name }`, `device.revoked { device_id, reason }`, `device.push_changed { device_id, enabled }`, `fleet.stopped { run_ids }`, `notification.sent { channel, device_id, kind, run_id }`, `notification.failed { channel, device_id, kind, status, message }`. `run.status_changed` gains the reasons `user` and `kill switch` on `→ paused`, and `task.status_changed` gains `pause` on `running → interrupted`.
- Credentials live in tables the daemon owns that are **not** projections: the refresh-token hashes, the push subscriptions and their keys. Rebuilding projections from events leaves them untouched. A device's existence and revocation come from events, so a revoked device stays revoked.

## Rules

- **One core, many surfaces** (rule 1): the phone is the same SPA over the same Core API. Notifications are built by the daemon.
- **Every side effect through the Policy Engine** (rule 3): `run.pause`, `run.resume`, `fleet.stop` and `notification.send`.
- **Secrets** (rule 7): tokens and push keys never reach events or logs. The redactor learns the token shapes (`nvd_…`, `nvr_…`).
- **No new states** (§8.3/§8.4): `paused` already exists, and pausing adds reasons only.
- Content from issues is untrusted (T1). A run title shown in a notification is plain text, truncated, and never interpreted.

## Tests (no network, no real agent)

- Contracts: devices, push and stop payloads, and the new events.
- Push crypto: the RFC 8291 Appendix A vector (fixed keys and salt give the published ciphertext), VAPID JWT claims and signature verified with the public key, and a fake push service over local HTTPS. The fake service checks the headers (`TTL`, `Urgency`, `Content-Encoding: aes128gcm`, `Authorization: vapid t=…, k=…`), and a 410 answer drops the subscription.
- Devices: pairing code is single use and expires; access token expiry and tampering; refresh rotation, where reusing an old refresh token revokes the device; a revoked device gets 401; the device scope allowlist (secrets, pairing and the concierge give 403); the actor carries `device_id`.
- Pause, resume and stop with the fake Claude: pausing interrupts a running task without using an attempt, nothing is dispatched while paused, approving while paused does not start the task, resume returns to the status before the pause and the agent resumes its session, stop pauses every active run, and policy denials give 403.
- Notifier: the event → notification table, quiet hours (critical passes), coalescing within 10 s, the endpoint allowlist, `notification.sent` and `notification.failed`.
- CLI: `navarch pause`, `navarch stop --all`, `navarch remote status` (fake `tailscale` on PATH) and `navarch devices`.
- Web: the mobile layout breakpoints, Home, New run, Device, the pairing QR, the session refresh flow in the API client, the manifest served with the right type, and complete locales.
- Visual check (2026-10-15): a demo daemon with slow fake agents, one approval waiting and two paired devices. Chromium at 390×844 as a paired device (Home, Approvals, Run, Device, New run), the pairing screen in light mode, and 1440×900 dark and light (Settings → Devices with the QR code, Home). The run detail's tab row overflowed on phones and was fixed. No console errors from the app.
- Notification texts are written by the daemon (`apps/daemon/src/notifications/messages.ts`) in the five UI locales, because the phone's system shows them, not the app. The device sends its locale with its subscription.

## 🔴 Open

- **Approve or reject from the notification itself**, without opening the app. The user would accept it only for low-risk changes (for example docs-only or very small diffs), which needs a risk classification of the change first. It does not ship in this slice.
- WebAuthn re-authentication, with the first high-risk action (manual merge, auto-merge, policy, budget).
- The relay topology (§6.12.2 option B, roadmap Phase 4) and ntfy, e-mail and chat channels.
- Diff by file, simplified TaskGraph and test results on the phone (§6.12.4 v1).
- Voice instructions (§19 idea 12).
