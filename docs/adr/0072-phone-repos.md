# 0072 — The phone picks and creates repositories

- Status: accepted
- Date: 2026-10-19
- Builds on: ADR 0020 (phone), ADR 0026 (GitHub repositories), ADR 0063 (phone chat)

## Context

ADR 0020 kept paired phones to registered projects, and ADR 0026 left listing and cloning to the desktop. The user pointed out that a phone that cannot choose or create a repository cannot start real work, which is the reason to have it.

## Decision

1. A phone may list the token's repositories and clone one (ADR 0026's rules hold: only listed ones, into the Navarch home, registered as a project).
2. A phone, or the desktop, may create a repository on the token's own account. Private by default, no owner from the client, a first commit so it can be cloned. Policy `repo.create` is the user's; an event records who.
3. Still desktop only: adding an arbitrary path as a project, secrets, pairing, flows and budgets. A run from a phone stays a prompt run in a known repository.

## Consequences

- 🟢 The phone can start work on anything the token reaches, or on something new.
- 🟡 A stolen, unrevoked phone can create repositories (private) and clone listed ones to the PC. It cannot read their contents through the API beyond what a run shows, push outside `navarch/*`, or change the token. Revoke it from Settings → Devices.
- 🟡 Creating needs a fine-grained token with Administration write on the account; without it GitHub's refusal is shown.
