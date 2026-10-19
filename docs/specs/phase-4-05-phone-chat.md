# Phase 4, slice 5 — phone chat and the CLI mascot

Status: implemented.

ADR 0063. Spec §9.2 (concierge), §15 (mobile).

## Behaviour

- `/chat` in the PWA (tab bar on phones): messages, proposals with Confirm and Reject, a microphone button (browser dictation), a paperclip for `.md`, `.markdown` and `.txt` files, and New chat.
- Devices may call `POST /api/v1/concierge/conversations`, `…/:id/messages` and `…/:id/proposals/:pid`. A device reaches only conversations it opened. Proposals run as `{ kind: "user", via: "mobile", device_id }`.
- `start_run` from a phone: a prompt and a registered or earlier-run repository only; anything else fails the proposal with the reason.
- `navarch` / `navarch chat` in a terminal print the ship banner; `NO_COLOR` drops colour, a non-terminal gets the plain header.

## Acceptance

- A phone cannot reach a desktop conversation, nor start a run with a Flow, budget or attachments through chat.
- The run a phone confirms records the device as the actor.
- The banner has no escape codes without colour.
