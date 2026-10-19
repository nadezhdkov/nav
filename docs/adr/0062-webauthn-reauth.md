# 0062 — Security keys and re-authentication (WebAuthn)

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0060 (auto-merge), ADR 0020 (device sessions), spec §11.1, §6.12

## Context

AGENTS.md and spec §11.1 ask for "re-authentication (WebAuthn) when available" before the actions that act without a human: turning auto-merge on is the first. The daemon token, which every local tool holds, proves nothing about the person at the keyboard.

## Decision

1. **Security keys.** The user registers WebAuthn credentials (`navigator.credentials.create`, ES256/P-256 only, `userVerification: required`, attestation `none`: Navarch wants the same key to sign later, not a hardware vendor's word). Their public parts, signature counters and names live in `webauthn_credentials`, a table that is not a projection; `webauthn.registered|removed|reauthenticated` are events with ids, names and purposes only. The ceremonies are checked with `node:crypto` and a small CBOR reader (`apps/daemon/src/webauthn/`), no library, like Web Push.
2. **A touch earns a token.** `POST /api/v1/reauth/options` issues a challenge for a purpose (`automerge.enable`, `webauthn.change`); `POST /api/v1/reauth/verify` checks the signed assertion (relying-party hash, origin, challenge, user present and verified, signature, counter moving forward) and returns a token that is single use, bound to its purpose and valid for two minutes. Challenges are single use too, spent even when the answer is wrong, and live in memory.
3. **What needs the token** once at least one key exists: turning auto-merge on (`SetAutoMergeRequest.reauth`), adding another key and removing one. Turning auto-merge off never does. The first key needs nothing, since there is nothing to protect yet; so a daemon token alone cannot plant a key of its own after that. With no key, behavior is as in ADR 0060 (the repository's name typed back).
4. **Who.** Policy action `webauthn.set` allows the user from the desktop only; paired phones, agents and the system are denied, and none of the routes is in the device allowlist.
5. **Domain names only.** WebAuthn rejects IP addresses as relying parties, so keys work at `http://localhost:<port>` or the Tailscale HTTPS name, and each key is tied to the address it was made at. `navarch web` now opens `localhost` instead of `127.0.0.1` (the same loopback daemon). The Security screen says so when opened at an IP.
6. **CLI.** A terminal has no authenticator: with a key registered, `navarch automerge on` answers `reauth_required` and points to Settings → Security. Turning it off still works from the CLI.
7. **Web UI.** `/settings/security`: keys (register, remove) and auto-merge per project (conditions, name typed back, touch, state, why each PR waits).

## Consequences

- 🟡 The browser flow was not exercised against a real authenticator in tests: the ceremonies are covered by a software authenticator built on `node:crypto` (signature, challenge, origin, flags, counter), and the screen was checked by screenshot.
- 🟡 A key is tied to the address it was registered at; one made at `localhost` does not work on the Tailscale name.
- 🟡 Other sensitive actions (Away mode, budgets) do not ask for a key yet; the purposes list is where they would go.
- 🔴 Only ES256; no attestation checks; no recovery if the only key is lost (remove it from the database, or restart without it: `webauthn_credentials` is plain SQLite).
