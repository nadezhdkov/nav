# Phase 4, slice 7a — the relay

Status: implemented (server, protocol, daemon connector). The phone's loader is slice 7b. ADR 0066. Spec §6.12.2 option B.

## Behaviour

- `make relay` runs `navarch-relay` (`--port`, `--host`, `--state`, `--max-relays`). It forwards frames and holds no key.
- With `daemon.remote.mode: relay` and `daemon.remote.relay_url`, `navarchd` dials `/d`, authenticates with its id and token, and serves phones. `navarch remote status` shows `relay: connected` and the address; pairing from the Web UI gives `<relay>/r/<id>/#pair=<code>`.
- A phone handshakes with the pairing code (pairing channel: `enroll` only) or with its device secret (device channel: API calls and the event stream, with its own bearer token).

## Acceptance

- The relay cannot read, replay or forge frames; a wrong secret, a spent pairing code and a revoked device are refused.
- Through the relay the local token is refused and the device allowlist applies.
- Paths outside the daemon's API, unknown methods and unlisted headers are refused.
- The daemon reconnects when the relay returns.
