# Phase 4, slice 4: WebAuthn security keys

Status: implemented · Branch: `feat/webauthn` (stacked on `feat/auto-merge`) · Spec: §11.1 · ADR: 0062

## Behavior

- `/settings/security` (desktop): register and remove security keys; turn auto-merge on and off per project.
- `POST /api/v1/reauth/options|verify` give a single-use, two-minute, purpose-bound token after a touch. With a key registered, `PUT /api/v1/projects/:id/auto-merge` to turn it on, and adding or removing a key, need one. `GET /api/v1/security-keys`, `POST /api/v1/security-keys/register/options|register`, `POST /api/v1/security-keys/:id/remove`. None is open to paired devices.
- `navarch web` opens `http://localhost:<port>`; WebAuthn rejects IP addresses.
- Events `webauthn.registered|removed|reauthenticated`; the keys' public parts are in `webauthn_credentials`.

## Acceptance (`apps/daemon/test/webauthn.test.ts`)

- A software authenticator registers a key and signs an assertion; the token is single use, scoped to its purpose and expires after two minutes.
- Refused: a phone or an agent, an IP-address origin, a wrong challenge or origin, a missing user-verified flag, a bad signature, a counter that does not advance, a reused or expired challenge.
- Adding or removing a key needs an existing one; turning auto-merge on needs a token once a key exists, and turning it off never does.

## Not in this slice

- Keys for Away mode or budgets, other algorithms, attestation checks, key recovery, a CLI touch.
