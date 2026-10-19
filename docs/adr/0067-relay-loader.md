# 0067 — The phone's loader: the app through the relay

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0066 (the relay), ADR 0020 (the PWA and device sessions)
- Slice: 7b

## Context

ADR 0066 built the relay, the end-to-end protocol and the daemon's connector, tested with a client written in the tests. A phone still could not use it. The user chose the stronger design for delivering the app: the relay supplies only a minimal loader, and the app itself comes from the daemon through the encrypted tunnel.

## Decision

1. **The relay serves four small files** under `/r/<relay id>/`: `index.html` (the loader page), `loader.js`, `loader.css` and `sw.js`, built by `make relay-build` into `apps/relay/dist` from `apps/relay/phone/` (Vite, one plain script each). Any other address under the id answers the loader page until the service worker can answer it. The page has a strict CSP (own script and style only, connections to the relay).
2. **Pairing in the loader.** The QR link is `<relay>/r/<id>/#pair=<code>`. The loader reads the code, removes it from the address bar and history (a fragment is never sent to a server), runs the end-to-end `enroll` on a pairing channel, and keeps the device id and its secret in IndexedDB. It writes the device session where the app expects it (`navarch.device/r/<id>` in localStorage, one key per relay address).
3. **The service worker is the phone's end of the tunnel.** Under `/r/<id>/` it answers every request by asking the daemon through the tunnel (reconnecting when it drops, and refusing when the phone has no credentials), so the app that runs is the daemon's own. It forwards only a few headers, keeps the daemon's security headers (CSP among them) on the answer, and turns a failed tunnel into a 503 that the app already reads as "not reachable". It also shows Web Push notifications under the same scope.
4. **The app is rewritten on the way, not rebuilt.** HTML, CSS and the manifest are rewritten so absolute links (`/assets/…`, `/icons/…`) stay under `/r/<id>`; HTML also gets `<meta name="navarch-base" content="/r/<id>">`. The app reads it (`apps/web/src/api/base.ts`) and prefixes its API calls, router base, logo and storage key; the build prefixes the module preloads at run time. Nothing changes when the app is served from the daemon's own address.
5. **Live updates by polling.** The event stream is a WebSocket the worker cannot answer, so behind a relay the app refetches its views every five seconds while the page is visible. A tunnelled stream is a later step.
6. **A page's burst is queued, not refused.** The client lets at most 14 requests wait on the daemon at once and queues the rest, since a page asks for dozens of files together.
7. **The client reports why a connection ended** (the relay's close code), so the phone can say "your computer is offline" (4404) or "this phone is no longer paired" instead of a generic error.

## Consequences

- 🟡 **First use trusts the relay for code.** The loader and the worker come from the relay, so a hostile relay could serve a bad worker to a phone that has not installed one, or push one later through the browser's worker update check. The worker is small and the app itself still comes from the daemon, but this is the limit of what a relay can promise; hosting the relay yourself removes it.
- 🟡 The device secret lives in IndexedDB of the relay's origin, next to the code that uses it; a page of the relay can read it (it is the same code the relay already supplies).
- 🟡 Polling makes more requests than a socket would (all views, every five seconds); a phone on mobile data pays for it while the app is open.
- 🟡 Verified in a real Chromium (pairing from the QR link, the app on a phone-sized screen, no console errors) but not on iOS or Android devices, and Web Push through the relay is untested.
- 🟡 Flow Studio's lazily loaded styles are not reachable through the relay (desktop only).
- 🔴 No tunnelled live stream, no offline shell for the installed app behind a relay, no way to pair a second daemon from the same phone in one tab session beyond the per-address keys.
