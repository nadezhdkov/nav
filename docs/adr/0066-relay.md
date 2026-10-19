# 0066 — The relay: remote access without Tailscale, end to end encrypted

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0020 (Tailscale and device sessions), spec §6.12.2 option B, T5
- Slices: 7a (this one: server, protocol, daemon connector) and 7b (the phone's loader and PWA over the relay)

## Context

ADR 0020 made Tailscale the only way to reach the daemon from a phone. Spec §6.12.2 names a second option: the PC keeps an **outgoing** connection to a relay, which only forwards messages **encrypted end to end** between phone and PC and cannot see their content. The user asked for it, with the minimal-loader design for the app (below), built in parts.

## Decision

1. **A relay is a small program** (`apps/relay`, `navarch-relay`, `make relay`) that anyone can host: two WebSocket endpoints, `/d` for the daemon and `/p/<relay id>` for phones, plus `/healthz`. It copies `{ t: "data" }` frames between a phone's socket and the daemon's, one channel per phone. It holds **no key** and understands nothing it forwards. It speaks plain HTTP/WebSocket and expects a TLS proxy in front.
2. **Who owns a relay id.** The daemon has a random id and token (`~/.navarch/relay/identity.json`, 0600). The first daemon to present an id with a token owns it; later connections need the same token. The relay keeps only the SHA-256 of the token, and limits the ids it registers, phones per id and new connections per address.
3. **End to end.** Phone and daemon share a secret the relay never sees: for pairing, the **pairing code from the QR code's `#fragment`** (fragments are never sent to a server); afterwards a per-device secret `HMAC(relay key, "device:" + id)` that the daemon gives the phone inside the encrypted pairing session. A two-message handshake authenticates fresh P-256 keys under that secret (HMAC over a length-framed transcript); the traffic keys are HKDF of the ECDH result, one per direction, so a later leak of the secret does not open recorded sessions. Frames are AES-256-GCM with a counter nonce and a direction in the AAD; a counter that does not go up is refused (no replay, no reordering, no reflection). Everything is WebCrypto, written once in `packages/relay-protocol`, so the daemon, tests and the phone's loader share it.
4. **The daemon serves a phone by calling its own API on loopback** with the phone's bearer token, so the device allowlist, the Policy Engine and every other rule apply unchanged. The connector forwards only a few headers, allows only `GET|HEAD|POST|PUT|DELETE` on absolute paths without dot segments, caps bodies, requests in flight and streams per phone, and marks every forwarded call with `x-navarch-relay`. **A marked request never gets the local token's powers**: through the relay only a paired device's token works.
5. **Pairing channels only enroll.** A channel opened with a pairing code can send one `enroll` message: the daemon pairs the device, returns the session and the device secret, and closes the channel. The code is single use as before. A device channel cannot enroll. A revoked device loses its channel at its next frame and cannot connect again.
6. **Handshake cost.** The MAC is checked before any key is generated; the daemon accepts at most 30 handshakes a minute and a channel gets one attempt.
7. **Configuration.** `daemon.remote.mode: relay` and `daemon.remote.relay_url`. `navarch remote status` and the pairing URL (`<relay>/r/<id>/#pair=<code>`) follow.
8. **The phone loads the app through a minimal loader (slice 7b, ADR 0067).** The relay serves only a small page that does the handshake with the key from the fragment; the rest of the app comes from the daemon through the encrypted tunnel, by a service worker. Slice 7a had no loader (the tests used a client on the same protocol); 7b adds it.

## Consequences

- 🟡 The relay sees metadata: which ids are online and when, sizes and timing, and addresses. It cannot read, alter, replay or inject traffic.
- 🟡 The first page load of a phone comes from the relay (the loader), so a malicious relay could serve a bad loader to a phone that has not installed it yet; ADR 0067 keeps that code small and delivers the app itself from the daemon, but a hostile relay at first use stays a risk. Self-hosting removes it.
- 🟡 A stolen pairing QR code is worth one pairing for five minutes, as before; a stolen device secret works until the device is revoked.
- 🟡 Responses are limited to 8 MiB and requests to 256 KiB.
- 🔴 Web Push through the relay is untested (push goes to the vendor's service as before; the subscription travels through the tunnel). Nobody runs a public relay for others; there is no accounting or abuse handling beyond the limits above.
