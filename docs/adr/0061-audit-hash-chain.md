# 0061 — Hash-chained event log

- Status: accepted
- Date: 2026-10-19
- Builds on: spec §10.3 ("hash encadeado opcional no event store"), ADR 0002 (SQLite event store)

## Context

The event log is append-only by SQLite triggers, but anyone with the file can drop the triggers and edit history. Spec §10.3 asks for a hash chain to detect that, and for a per-run audit export.

## Decision

1. **Always on, no switch.** Each event stores `hash = sha256(JSON([prev, id, ts, type, run_id, task_id, actor, payload, schema_version]))`, where `prev` is the previous event's hash (`genesis` for the first) and `actor` and `payload` are the JSON text as stored. §10.3 says "optional"; a switch would leave gaps in the chain whenever it was off, so the chain is simply always written. It costs one hash per event, inside the append transaction (`apps/daemon/src/events/chain.ts`).
2. **Existing logs.** `ALTER TABLE events ADD COLUMN hash` runs on open. Events from before stay unhashed (the append-only triggers forbid a backfill) and are reported as `legacy`; the chain begins at the first event written afterwards. An unhashed event after the chain began is a break.
3. **Verifying.** `EventStore.verifyChain()` walks the log and reports the first break (`seq`, `id`, reason). The daemon does it at start and prints a warning; it keeps running, since stopping would hide the problem. `GET /api/v1/audit[?expect=<hash>]` and `navarch audit [verify] [--expect <hash>]` (exit 1 on a break or a head not found); not open to paired devices.
4. **The head is the anchor.** A chain protects the middle of the log: an edit, a deletion or a reorder breaks the hashes after it. It cannot see the **newest** events being cut off, nor a rewrite by someone who recomputes every hash. For that, the user keeps the `head` printed by `navarch audit` somewhere the daemon cannot write (a note, a commit, a chat message), and `--expect <hash>` later shows whether that point is still in the log.
5. **Per-run export.** `GET /api/v1/runs/:id/audit` and `navarch audit export <run> [--json]` return the run's events with actor, payload and hash, plus the log's chain report. Events are already redacted (architecture rule 7).

## Consequences

- 🟡 It detects tampering; it does not prevent it, and without a kept head the newest events can still be dropped unnoticed.
- 🟡 Verification reads the whole log at start; hashing is fast (hundreds of thousands of events in about a second).
- 🔴 No signing, no scheduled export of the head, no UI screen; the daemon does not record `audit.verified` events.
